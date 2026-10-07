const app = require('./src/app');
const sched = require('./src/scheduling');

const PORT = Number(process.env.PORT || 3000);

setInterval(() => {
  try {
    sched.expireHolds('sweeper');
  } catch (err) {
    console.error('hold expiry sweeper failed', err);
  }
}, Number(process.env.SWEEP_INTERVAL_MS || 10000)).unref();

app.listen(PORT, () => {
  console.log(`摄影师作品与预约站已启动: http://localhost:${PORT}`);
  console.log(`后台: http://localhost:${PORT}/admin  (开发令牌: ${process.env.ADMIN_TOKEN || 'dev-admin-token'})`);
});
