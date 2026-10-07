# Lumen Studio：摄影师作品与预约站

从零搭建的全栈示例：访客按风格浏览公开相册、选择套餐/时区/日期并预约；管理端维护摄影师、助手、器材、营业时间、人工封闭档期和订单。所有预约状态以服务器和持久化数据库文件为准，浏览器本地草稿只用于跨页/刷新恢复，不代表预订成功。

## 运行

```bash
npm install   # 本项目只使用 Node.js 内置模块，通常无依赖需要安装
npm start
# http://localhost:3000
# 后台 http://localhost:3000/admin
# 默认管理 Token：dev-admin-token
HOLD_TTL_MS=5000 npm run dev   # 便于演示短租约到期
npm test
```

环境变量：

- `PORT`：端口，默认 3000
- `ADMIN_TOKEN`：管理 API Bearer Token，默认 `dev-admin-token`
- `DATA_FILE`：JSON 持久化文件，默认 `./data/db.json`
- `HOLD_TTL_MS`：临时占位寿命，默认 90000ms

## 为什么冲突不能只比较拍摄起止

每个套餐版本保存：

- 正式拍摄时长 `durationMin`
- 到达交通 `travelInMin`
- 布置 `prepMin`
- 撤场 `breakdownMin`
- 离开交通 `travelOutMin`
- 多组资源需求（摄影师、第二摄影师/助手、相机、镜头、灯光、背景等）

真正占用区间为：

```text
开始时间 - 到达交通 - 布置
  → 开始时间 + 正式拍摄 + 撤场 + 离开交通
```

冲突比较使用半开区间 `[occupiedStart, occupiedEnd)`，因此相邻订单可以首尾相接，但交通、布置或撤场重叠会被拒绝。同一资源在同一时间只能被一个活动占位/已锁定订单使用；不同订单若只使用互不相关的资源，则可并行。

## 两种高峰竞争模型

### 1. 短租约占位（Temporary Hold）

- `POST /api/holds`：资源和营业时间可用时立即锁定，返回 `expiresAt`。
- 占位状态在 UI 上明确标为“临时占位 · 未成功预订”。
- `POST /api/holds/confirm`：必须带客户信息和新的 `idempotencyKey`，在到期前确认才创建已锁定订单。
- 到期后状态变 `expired`，资源立即释放；若有等待队列，按规则自动恢复/提升。
- 在到期边界并发确认时，所有写入经同一 FIFO 事务串行处理：事务读取时未过期才成功；已过期返回 `410 hold_expired` 并执行队列恢复。
- 已有更早且竞争相同资源的等待请求时，新的 hold 会返回冲突，防止用短占位插队。

### 2. 提交即排队确认

- `POST /api/bookings` 永远创建服务器订单草稿/记录：
  - 完整资源和营业时间可用：`confirmed`，已锁定。
  - 资源冲突、营业时间冲突或前面有相关队列：`waiting`，等待确认，不占资源。
- 已取消、人工改期、人工删除封闭档期或 hold 到期后，会重新评估等待者。
- 竞争同资源的等待者保持 FIFO；完全无关的等待者可以独立确认，不会被不相关订单阻塞。
- 前端通过颜色/文案清楚区分：等待确认（未锁）、临时占位（短时锁但不是订单）、已锁定（确认订单）。

## 幂等与取消

所有创建/确认/取消请求都要求 `idempotencyKey`：

- 相同 key + 相同请求指纹：返回已有实体，`duplicate: true`。
- 相同 key + 不同请求：`409 idempotency_key_reused`。
- 重复提交不会创建两个 hold、两个订单或两次取消。

取消规则：

- 只有交通、布置和正式拍摄占用都尚未实际开始的订单可由客户/后台取消并释放资源。
- 已取消请求重复发送返回原状态，不重复释放。
- 取消后触发等待队列重新评估。

## 套餐版本与客户保护

后台修改价格、时长、交通/布置/撤场、服务范围或资源需求时，只有发生实质变化才生成新版本。订单保存创建/确认时的完整 `snapshot`：

- 已预约客户保留原价格、币种、服务范围和资源需求。
- 新客户使用 `currentVersion`。
- 后台可查看历史版本和每个订单使用的版本号。

## 时区和夏令时

- 前端发送 IANA 时区（如 `Asia/Shanghai`、`America/New_York`）和本地钟面时间。
- 数据库与 API 一律存 UTC ISO 字符串。
- 营业档期按管理端时区换算；切换后台时区不会改变既有订单的 UTC 时刻。
- 春季跳变中不存在的本地时间返回错误。
- 秋季回拨的重复小时支持 `ambiguity: earlier | later`。
- 本地日期查询会按 DST 当天的 23/24/25 小时正确切成 UTC 区间。

## 公开照片、灯箱与授权撤销

- 公开相册只包含 `publicLicense=true` 的照片。
- `/api/albums/:id` 返回同一版本化清单：顺序、封面、媒体版本、授权条款和 `manifestDigest`。
- 灯箱序列、封面和公开媒体 URL 都来自该清单；媒体 URL 带 `?v=mediaVersion`。
- 撤销单张照片公开授权：
  - 公开灯箱立即移除该照片；
  - `/media/:id.svg` 返回 404；
  - 若它是封面，自动切到下一张公开照片；没有可替代照片时相册转为非公开。
- 撤销整个相册授权后，该相册不会出现在公开 API。

## 管理后台

`/admin` 输入 Bearer Token 后可：

- 查看等待、临时占位、已锁定和已取消订单。
- 人工确认等待订单；冲突时先显示解释，可明确强制覆盖。
- 人工改期：无冲突直接移动；有冲突返回资源/营业时间的详细解释，强制时写入审计。
- 维护每周营业时间、特殊开闭日期、人工资源封闭档期。
- 新增/停用摄影师、助手、器材。
- 修改套餐并产生新版本。
- 撤销/恢复照片和相册公开授权。
- 查看审计日志，包括 hold 到期、自动确认、取消、改期、强制冲突、授权变更等。

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/albums?style=portrait` | 公开相册清单 |
| GET | `/api/albums/:id` | 单个公开相册的版本化灯箱清单 |
| GET | `/media/:photoId.svg?v=n` | 已授权照片媒体；撤销后 404 |
| GET | `/api/packages` | 当前有效套餐 |
| GET | `/api/timeline?date=YYYY-MM-DD&timezone=...` | 当天等待/占位/锁定/封闭档期 |
| POST | `/api/preflight` | 预览 UTC 与完整占用窗口 |
| POST | `/api/bookings` | 提交即排队，空闲则确认 |
| POST | `/api/bookings/lookup` | 单号+邮箱查询 |
| POST | `/api/bookings/cancel` | 取消尚未开始占用的订单 |
| POST | `/api/holds` | 创建短时占位 |
| POST | `/api/holds/confirm` | 到期前确认占位 |
| POST | `/api/holds/lookup` | 查询占位 |
| GET | `/api/admin/state` | 后台完整状态（Bearer Token） |
| POST | `/api/admin/maintenance/prune` | 立即处理到期并恢复队列 |
| PUT | `/api/admin/schedule` | 修改时区/周期营业规则 |
| PUT/DELETE | `/api/admin/schedule/overrides...` | 特殊日期 |
| POST/DELETE | `/api/admin/blocks...` | 人工封闭/释放资源 |
| PUT | `/api/admin/packages/:id` | 编辑套餐并生成版本 |
| POST | `/api/admin/bookings/confirm` | 人工确认/强制确认 |
| POST | `/api/admin/bookings/reschedule` | 人工改期/强制覆盖 |
| POST | `/api/admin/bookings/cancel` | 后台取消 |
| PUT | `/api/admin/photos/:id/license` | 照片授权撤销/恢复 |
| PUT | `/api/admin/albums/:id/license` | 相册授权撤销/恢复 |

## 示例请求

```bash
curl -X POST http://localhost:3000/api/bookings \
  -H 'content-type: application/json' \
  -d '{
    "packageId":"pkg-portrait",
    "startLocal":"2027-05-04T10:00",
    "timezone":"Asia/Shanghai",
    "customer":{"name":"张三","email":"a@example.com"},
    "idempotencyKey":"customer-device-uuid"
  }'
```

## 测试覆盖

`npm test` 包含 18 个自动化测试：

- 两个客户争同一时段：第一个锁定、第二个等待、重复请求不重复下单。
- 交通/布置/撤场窗口重叠与真正相邻窗口。
- hold 到期同时确认：过期方返回 410，等待客户自动提升。
- hold 到期前重复确认只生成一个订单。
- 套餐改价/改服务范围后，老订单保留 v1 快照。
- 取消幂等与已开始占用保护。
- 时区切换、DST 春季缺口和秋季重复小时。
- 照片授权撤销、媒体 404、封面自动切换。
- 后台强制改期及冲突解释/人工记录。
- HTTP 层授权、公开清单、时间线状态区分。

## 持久化与并发

- 当前实现使用带原子写（临时文件 + rename）的 JSON 文档数据库，位置由 `DATA_FILE` 指定。
- 所有状态变更通过一个进程内 FIFO 事务队列串行化，使“检查冲突 → 状态转换 → 写入”成为原子序列。
- 无需外部数据库即可演示和验收；生产环境可把 `lib/store.js` 替换为 Postgres 事务/`SELECT ... FOR UPDATE`，调度状态机无需改变。
