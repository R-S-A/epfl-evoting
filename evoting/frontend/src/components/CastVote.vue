<template>
  <v-layout row wrap>
    <v-flex xs12 sm12 offset-md3 md6>
      <v-card>
        <v-toolbar card dark :class="election.theme">
          <v-toolbar-title class="white--text">{{  $t(`election_${getId(election)}.name`) }}</v-toolbar-title>
          <v-spacer></v-spacer>
          <div v-if="election.moreInfo">
            <a class="election-info" target="_blank" :href="election.moreInfo"><v-icon>info</v-icon></a>
          </div>
          <div v-if="voted">
            <v-tooltip bottom>
              <v-icon class="election-voted" dark color="white" slot="activator">check</v-icon>
              <span>{{ $t('message.ballotCast', { block: voted }) }} </span>
            </v-tooltip>
          </div>
        </v-toolbar>
        <v-card-title>
          <v-container fluid>
            <div v-if="voted">
              <v-layout>
                <v-flex xs12>
                  <v-card light color="yellow lighten-5"> {{ $t('message.voteAgain') }} </v-card>
		  <br>
                </v-flex>
              </v-layout>
	    </div>
            <v-layout>
              <v-flex xs12>
                {{ $t(`election_${getId(election)}.subtitle`) }}
              </v-flex>
            </v-layout>
            <br>
            <v-form v-model="valid" v-on:submit="submitHandler">
              <v-layout row wrap>
                <v-flex xs12>
                  <p>{{ $t("message.electionInstruction", { maxChoices: election.maxChoices }) }}</p>
                  <v-radio-group>
                    <v-checkbox
                      v-for="candidate in election.candidates"
                      :key="candidate"
                      :value="`${candidate}`"
                      v-model="ballot"
                      :rules=[validateBallot]
                      >
                      <template slot="label">
                        <a @click.stop target="_blank" :href="`https://people.epfl.ch/${candidate}`">{{ candidateNames[candidate] }}</a>
                      </template>
                    </v-checkbox>
                  </v-radio-group>
                </v-flex>
                <v-flex xs12 class="text-xs-center">
                  <v-btn type="submit" :disabled="!(valid && ballot.length !== 0) || submitted" color="primary">{{ $t('message.vote') }}</v-btn>
                </v-flex>
              </v-layout>
            </v-form>
          </v-container>
        </v-card-title>
      </v-card>
    </v-flex>
    <v-footer app>
      <v-layout row wrap>
        <v-flex xs6 text-xs-left>
          &copy; 2018 {{ election.footer.text }}
        </v-flex>
        <v-flex xs6 text-xs-right>{{ election.footer.contactPhone }}, <a :href="`mailto:${election.footer.contactEmail}`">{{ election.footer.contactTitle }}</a> <span class="grey--text">v{{ version }}</span></v-flex>
      </v-layout>
    </v-footer>
    <v-dialog v-model="dialog3" persistent max-width="500px">
      <v-card>
        <v-card-title>
          <span> {{ $t('message.cast') }} </span>
        </v-card-title>
        <v-card-actions>
          <v-btn color="primary" flat @click.stop="dialog3=false; $router.push('/')">Close</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-layout>
</template>

<script>
import kyber from '@dedis/kyber-js'
import {
  Uint8ArrayToHex,
  scipersToUint8Array,
  timestampToString,
  getSig
} from '../utils'
import version from '@/version'

const curve = new kyber.curve.edwards25519.Curve()

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export default {
  computed: {
    election () {
      return this.$store.state.elections.find(e => {
        return Uint8ArrayToHex(e.id) === this.$route.params.id
      })
    },
    voted () {
      const shortId = Uint8ArrayToHex(this.election.id).substring(0, 10)
      return this.$store.state.voted[shortId]
    }
  },
  methods: {
    getId (election) {
      return Uint8ArrayToHex(election.id)
    },
    endDate (timestamp) {
      return timestampToString(timestamp, true)
    },
    validateBallot (ballot) {
      const { election } = this
      const i18n = this.$i18n
      if (ballot.length <= election.maxChoices) {
        this.valid = true
        return true
      }
      this.valid = false
      return i18n._t('message.maxAllowed', i18n.locale, i18n._getMessages(), this, { max: election.maxChoices })
    },
    dateStr (timestamp) {
      return timestampToString(timestamp, true)
    },
    submitHandler (e) {
      e.preventDefault()
      this.submitted = true

      const { key } = this.election
      // encrypt the ballot
      let { ballot } = this
      ballot = new Set(ballot)
      const embedMsg = scipersToUint8Array(Array.from(ballot))
      const m = curve.point().embed(embedMsg)
      const r = curve.scalar().pick()
      // u = gr
      const u = curve.point().mul(r, null)
      // v = m + yr
      const y = curve.point()
      y.unmarshalBinary(key)
      const yr = curve.point().mul(r, y)
      const v = curve.point().add(m, yr)

      // prepare and the message
      const castMsg = {
        id: this.election.id,
        ballot: {
          user: parseInt(this.$store.state.user.sciper),
          alpha: u.marshalBinary(),
          beta: v.marshalBinary()
        },
        user: parseInt(this.$store.state.user.sciper),
        signature: getSig()
      }
      const { socket } = this.$store.state
      socket
        .send('Cast', 'CastReply', castMsg)
        .then(data => {
          this.submitted = false
          this.$store.state.voted[Uint8ArrayToHex(this.election.id).substring(0, 10)] =
            Uint8ArrayToHex(data.id).substring(0, 10)
          this.dialog3 = true
        })
        .catch(e => {
          this.submitted = false
          this.$store.commit('SET_SNACKBAR', {
            color: 'error',
            text: e.message,
            model: true,
            timeout: 10000
          })
        })
    }
  },
  data () {
    return {
      ballot: [],
      valid: false,
      submitted: false,
      candidateNames: {},
      version: version,
      dialog3: false
    }
  },
  created () {
    const scipers = this.election.candidates
    for (let i = 0; i < scipers.length; i++) {
      const sciper = scipers[i]
      this.candidateNames[sciper] = this.$store.state.names[sciper] || 'loading...'
      if (this.candidateNames[sciper] !== 'loading...') {
        continue
      }
      var sltime = 0
      if (i > 5) {
        sltime = 2000
      }
      sleep(sltime).then(() => {
        this.$store.state.socket
          .send('LookupSciper', 'LookupSciperReply', {
            sciper: sciper.toString()
          }).then(response => {
            this.candidateNames = {
              ...this.candidateNames,
              [sciper]: response.fullName
            }
            // cache
            this.$store.state.names[sciper] = this.candidateNames[sciper]
          })
          .catch(e => {
            this.candidateNames = {
              ...this.candidateNames,
              [sciper]: 'SCIPER ' + sciper + ' not found'
            }
          })
      })
    }
  },
  watch: {
    candidateNames: {
      deep: true,
      handler (val, oldVal) {}
    }
  }
}
</script>

<style>
.input-group label {
  overflow: visible;
}
</style>
