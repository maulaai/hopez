module.exports = {
  apps: [
    {
      name: 'hopez-api',
      cwd: '/opt/hopez/backend',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      error_file: '/var/log/hopez/api.err.log',
      out_file: '/var/log/hopez/api.out.log',
      max_memory_restart: '512M'
    },
    {
      name: 'hopez-web',
      cwd: '/opt/hopez/frontend',
      script: 'src/server.js',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
      error_file: '/var/log/hopez/web.err.log',
      out_file: '/var/log/hopez/web.out.log',
      max_memory_restart: '256M'
    }
  ]
};
