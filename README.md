# 摄影师作品与预约站

一个从零搭建的全栈示例：访客按风格浏览公开相册、在灯箱中查看同一发布版本的授权照片序列、选择套餐/日期/摄影师、助手和器材；管理端维护档期、解释冲突、处理排队、改期和照片许可。

## 技术栈

- Node.js + Express
- SQLite（`better-sqlite3`，同步事务，预编译语句）
- 原生 HTML/CSS/JavaScript，无前端框架
- 数据库文件：`data/app.sqlite`

## 启动

```bash
npm install
npm start
# http://localhost:3000
# http://localhost:3000/admin  开发令牌 dev-admin-token
```

可配置环境变量：

```bash
PORT=3000
ADMIN_TOKEN=replace-me
HOLD_TTL_MS=300000       # 短租约占位有效期，默认 5 分钟
SWEEP_INTERVAL_MS=10000  # 后台过期扫描间隔
DB_FILE=./data/app.sqlite
```

运行验收：

```bash
npm test
```

测试会启动独立进程和独立 SQLite 文件，覆盖：

1. 两个客户争同一时段；
2. 即使“正式拍摄起止”不重叠，交通/布置/撤场/返程重叠也冲突；
3. 排队不锁定，短占位临时锁定，占位到期后资源恢复；
4. 占位到期与确认竞争；
5. 不同时区/UTC offset 规范化存储；
6. 套餐改价和范围变更后，旧预约保留快照；
7. 已开始占用不能取消释放；
8. 幂等键重复提交不会创建两份；
9. 照片许可撤销的待发布状态、发布后灯箱/封面/授权版本一致；
10. 后台停用档期、冲突解释、人工改期审计；
11. 草稿预览不入库，本地草稿明确不是成功预订。

## 两种高峰处理方式

### 1. 短租约占位（hold）

`POST /api/bookings` 传 `"mode":"hold"`。

- 成功后状态为 `held`；
- 立即占用摄影师、助手、器材的交通、布置、拍摄、撤场和返程时间段；
- `hold_expires_at` 前客户可调用确认；
- 到期未确认由事务和后台 sweeper 标记 `cancelled`，并删除资源占用；
- 适合低到中度竞争，给客户明确倒计时，但不应把“占位”显示成最终成功。

### 2. 提交即排队确认（queue）

`POST /api/bookings` 传 `"mode":"queue"`。

- 成功后状态为 `queued`，有 `queue_position`；
- 排队订单写入客户和意向资源，但这些资源时间段不参与冲突锁；
- 后台调用 `/api/admin/bookings/:ref/confirm-queue` 时才重新做完整冲突检查并锁定；
- 适合高峰抢档：多个客户可先进入等待队列，后台按实际沟通和资源情况确认。

网页使用不同颜色和文案明确区分：

- `held`：等待确认/短租约占位，可能过期；
- `queued`：排队中，不锁定；
- `confirmed`：已锁定；
- `cancelled`：取消或过期，资源释放。

## 为什么不能只比较拍摄起止

每个套餐会生成五段：

1. `travel_before` 前往现场；
2. `setup` 布置与测光；
3. `shoot` 正式拍摄；
4. `teardown` 撤场；
5. `travel_after` 返程/转场。

一次拍摄可同时占用多名资源：摄影师、助手、器材，甚至场地。冲突检测按“资源 × 时间段”判断：

```text
existing.start < requested.end AND requested.start < existing.end
```

因此一个客户 02:00–03:30 拍摄，另一个客户 03:30 开拍仍可能冲突：前者 03:30 之后还在撤场或返程，后者 03:30 前已进入交通和布置。

冲突响应会列出资源、请求阶段、已有阶段、重叠分钟数；后台维护记录还可能作为 `admin_block` 出现。

## 关键业务规则

### 幂等创建

创建预约可传 `idempotency_key`。服务端在同一个立即 SQLite 事务中先查唯一键：

- 首次：创建预约；
- 重试：返回原预约和 `idempotent_replay: true`；
- 不会创建两份。

### 报价和服务范围快照

下单时将套餐名称、价格、币种、时长、交通布置时间、服务范围和套餐版本复制到 `bookings.package_snapshot`。

之后管理端修改套餐：

- 新客户看到新价格和新范围；
- 已存在的 held/queued/confirmed 订单继续使用原快照。

### 取消限制

取消只允许释放第一个资源占用阶段仍未开始的订单：

- 未开始 held/queued/confirmed：取消并删除资源时间段；
- 任一 travel/setup/shoot/teardown/travel 阶段已开始：拒绝自助释放；
- 重复取消返回原取消结果，不重复执行。

### 人工改期

管理端改期会：

1. 使用订单快照中的套餐时间结构；
2. 重新生成所有资源阶段；
3. 排除自身后做完整冲突检查；
4. 有冲突则原档期保持不变并返回解释；
5. 成功后写 `manual_reschedule` 审计记录。

### 后台停用档期

`POST /api/admin/blocks` 可让摄影师/助手/器材在某区间不可安排。若与现有订单冲突，默认拒绝并返回解释；`force:true` 可保留该拦截规则，但不会自动删除客户已锁定订单。之后的新预约或改期会同时看到客户订单与后台停用冲突。

## 照片许可与发布版本

照片有两套授权状态：

- `working_public_license`：管理端工作区的最新意图；
- `published_public_license`：当前公开版本。

撤销许可后不会立刻改变公开页面，必须在后台发布相册。发布时：

- 灯箱序列只包含当前已发布授权的照片；
- 若封面被撤销，自动换成第一张授权照片；
- 照片和相册带有相同 `published_version`；
- API 不暴露未发布撤销或旧版本照片。

## 草稿策略

公开页面把未提交表单保存在浏览器 `localStorage`，用于跨刷新/跨页恢复。它：

- 可以恢复套餐、资源、日期、时区、联系信息；
- 会显示明确提示“不是成功预订”；
- 不创建后端订单；
- 不占用任何档期；
- 成功提交后删除本地草稿。

## 主要 API

### 公开

- `GET /api/styles`
- `GET /api/albums?style=wedding`
- `GET /api/albums/:id`
- `GET /api/packages`
- `GET /api/resources`
- `GET /api/availability?package_id=1&start_at=...&timezone=Asia/Shanghai&resources=1,5`
- `POST /api/bookings/preview`
- `POST /api/bookings`
- `GET /api/bookings/:ref`
- `POST /api/bookings/:ref/confirm`
- `POST /api/bookings/:ref/cancel`

### 管理端（请求头 `x-admin-token`）

- `GET /api/admin/bookings`
- `POST /api/admin/bookings/:ref/confirm-queue`
- `POST /api/admin/bookings/:ref/reschedule`
- `POST /api/admin/bookings/:ref/cancel`
- `POST /api/admin/blocks`
- `GET /api/admin/blocks`
- `DELETE /api/admin/blocks/:id`
- `PUT /api/admin/packages/:id`
- `GET /api/admin/albums`
- `PUT /api/admin/photos/:id/license`
- `POST /api/admin/albums/:id/cover`
- `POST /api/admin/albums/:id/publish`
- `GET /api/admin/audit-logs`

## 数据模型概览

- `styles` / `albums` / `photos`：作品风格、相册、照片许可和版本；
- `packages` / `package_resources`：套餐、时间缓冲、服务范围和默认可用资源；
- `resources`：摄影师、助手、器材、场地；
- `bookings`：订单状态、客户信息、UTC 时间、时区和套餐快照；
- `booking_resources`：订单中每个资源的每个占用阶段；
- `blocks`：管理端停用/维护档期；
- `audit_logs`：过期、确认、取消、改期、套餐修改、发布等记录。
