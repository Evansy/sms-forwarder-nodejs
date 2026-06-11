// PM2 配置 - 使用 .cjs 后缀因为项目是 ESM
module.exports = {
  apps: [
    {
      name: 'sms-forwarder',
      script: './src/app.js',
      autorestart: true,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
