const express = require('express')
const path = require('path')
const app = express()
const config = require('./config')
const util = require('./util')
const router = require('express-promise-router')()
const axios = require('axios')
const kyber = require('@dedis/kyber-js')
const hexToArrayBuffer = require('hex-to-array-buffer')
const LdapClient = require('promised-ldap')

const PORT = process.env.PORT || 3000
const isProd = process.env.NODE_ENV === 'production'
const isTest = process.env.NODE_ENV === 'test'

const tequilaRequest = (path, data) => {
  dataStr = util.dict2txt(data)
  const target = `https://${config.tequila.hostname}${path}`
  return axios.post(target, dataStr)
}

const getLdapData = (sciper) => {
  const client = new LdapClient({ url: `ldap://${config.ldap.hostname}` })

  const opts = {
    filter: '(&(objectClass=person)(uniqueIdentifier=' + sciper + '))',
    scope: 'sub',
    attributes: ['uniqueIdentifier', 'memberOf', 'dn', 'displayName']
  }

  const base = 'o=epfl, c=ch'

  return client.search(base, opts)
}

if (!isProd) {
  router.get('/', (req, res) => res.sendFile(path.join(__dirname, '/dist/index.html')))
  router.use('/static', express.static(path.join(__dirname, '/dist/static')))
}

const generateSignature = (sciper, masterKey) => {
  sciper = typeof sciper === 'string' ? sciper : sciper.toString()
  const message = new Uint8Array(masterKey.length + sciper.length)
  message.set(masterKey)
  for (let i = 0; i < sciper.length; i++) {
    message[i + masterKey.length] = sciper[i] - '0'
  }
  const suite = new kyber.curve.edwards25519.Curve()
  const key = suite.scalar()
  key.unmarshalBinary(new Uint8Array(hexToArrayBuffer(process.env.PRIVATE_KEY)))
  return kyber.sign.schnorr.sign(suite,
    key,
    message
  )
}

router.get('/auth/login', (req, res) => {
  let data = {
    client: 'evoting-auth',
    urlaccess: `${req.protocol}://${req.hostname}/auth/verify`,
    service: 'Evoting App',
    request: 'uniqueid',
    forcelogin: '1'
  }
  tequilaRequest ('/cgi-bin/tequila/createrequest', data)
    .then(response => {
      const data = util.txt2dict(response.data.trim())
      res.redirect(307, `https://${config.tequila.hostname}/cgi-bin/tequila/auth?requestkey=${data.key}`)
    })
    .catch(e => {
      console.error(e.message)
    })
})

router.get('/auth/login/txt', (req, res) => {
  let data = {
    client: 'evoting-auth',
    urlaccess: `${req.protocol}://${req.hostname}/auth/verify/txt`,
    service: 'Evoting App',
    request: 'uniqueid',
    forcelogin: '1'
  }
  tequilaRequest ('/cgi-bin/tequila/createrequest', data)
    .then(response => {
      const data = util.txt2dict(response.data.trim())
      res.redirect(307, `https://${config.tequila.hostname}/cgi-bin/tequila/auth?requestkey=${data.key}`)
    })
    .catch(e => {
      console.error(e.message)
    })
})

router.get('/auth/verify/txt', (req, res) => {
  payload = { key: req.query.key }

  return tequilaRequest('/cgi-bin/tequila/fetchattributes', payload)
    .then(response => {
      const data = util.txt2dict(response.data.trim())
      const sciper = data.uniqueid

      // Sign the data
      signature = generateSignature(sciper, config.masterKey)

      // Prepare result
      user = {
        sciper,
        signature: util.Uint8ArrayToHex(signature),
      }

      // Send it
      res.send(JSON.stringify({ user }))
    })
    .catch(e => {
      console.error(e)
      res.end()
    })
})

router.get('/auth/verify', (req, res) => {
  payload = { key: req.query.key }
  if (isTest) {
    const { sciper } = req.query
    const masterKey = process.env.MASTER_KEY.trim().split(" ").map(x => parseInt(x))
    signature = generateSignature(sciper, masterKey);
    res.setHeader('Content-Type', 'application/json')
    res.send(JSON.stringify({ signature: Array.from(signature), masterKey }));
    return
  }

  return tequilaRequest('/cgi-bin/tequila/fetchattributes', payload)
    .then(response => {
      const data = util.txt2dict(response.data.trim())
      const sciper = data.uniqueid
      return getLdapData(sciper)
    })
    .then(ldapReq => {
      const ldapData = ldapReq.entries[0].object
      const groups = ldapData.memberOf
      const name = ldapData.displayName
      const sciper = ldapData.uniqueIdentifier
      const sections = []
      let sectionRegex = /ou=(\w+)/g
      let match
      while ((match = sectionRegex.exec(ldapData.dn), match)) {
        sections.push(match[1])
      }

      // Sign the data
      signature = generateSignature(sciper, config.masterKey)
      user = {
        name,
        sciper,
        groups,
        sections,
        signature: Array.from(signature) // JSON stringification is messed up with TypedArray
      }
      res.render('template', { state: JSON.stringify({ user }) })
    })
    .catch(e => {
      console.error(e)
      res.end()
    })
})

app.use(router)
app.set('view engine', 'pug')
// req.hostname is read from X-FORWARDED-HOST header in prod
if (isProd) {
  app.enable('trust proxy')
}
app.listen(PORT, () => console.log('Running the server on port ' + PORT))
