import { createApp } from './lib/http.js';

const port = Number(process.env.PORT || 3000);
const app = createApp();

app.listen(port, () => {
  console.log(`摄影师作品与预约站已启动: http://localhost:${port}`);
  console.log(`管理页: http://localhost:${port}/admin (默认 Bearer Token: ${process.env.ADMIN_TOKEN || 'dev-admin-token'})`);
});
