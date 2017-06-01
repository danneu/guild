module.exports = function (shipit) {
  require('shipit-deploy')(shipit)

  const deployTo = '~/guild'

  shipit.initConfig({
    default: {
      workspace: '/tmp/guild',
      deployTo,
      keepReleases: 2,
      ignores: ['.git', 'node_modules'],
      //rsync: ['--del'],
      deleteOnRollback: false,
      shallowClone: true,
      repositoryUrl: process.cwd() + '/.git',
      branch: 'production'
    },
    production: {
    }
  })

  shipit.blTask('install', () => {
    return shipit.remote(`cd ${deployTo}/current && nvm use && npm install`)
  })

  shipit.blTask('start', () => {
    return shipit.remote(`cd ${deployTo} && nvm use $(current/.nvmrc) && pm2 startOrReload current/ecosystem.json`)
  })

  shipit.blTask('stop', () => {
    return shipit.remote('pm2 stop all')
  })

  shipit.on('deployed', () => {
    shipit.start('install',  'start')
  })
}
