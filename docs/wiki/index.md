# RustDesk Console — Code Wiki 导航索引

> 项目版本 1.11.0 · 技术栈：NestJS 11 + TypeScript + TypeORM 0.3 + SQLite/MySQL/MariaDB  
> 这是一套后端源码级的结构化文档，覆盖架构、模块、数据库、系统更新、运行方式五大主题。

---

## 文档目录

| # | 文档 | 核心主题 | 适合读者 |
|---|------|----------|----------|
| 01 | [项目总览与架构](00-项目总览与架构.md) | 项目定位、顶层目录、启动流程、模块分层、关键依赖、运行形态 | 第一次接触项目 |
| 02 | [模块职责与关键类](02-模块职责与关键类.md) | 21 个 feature module 的 Controller/Service/Guard/Entity 清单、模块依赖图 | 深入理解某个模块、排查类名 |
| 03 | [数据库实体与迁移](03-数据库实体与迁移.md) | 31 个 Entity 分组、实体关系图、7 个迁移脚本、SQLite/MariaDB 兼容处理 | 改 schema、写迁移、排查数据问题 |
| 04 | [系统更新子系统](04-系统更新子系统.md) | Updater 独立进程模型、IPC 协议、Planner/Control/Worker、部署/备份适配器、维护栅栏 | 理解/修改自动更新机制 |
| 05 | [依赖关系与运行方式](05-依赖关系与运行方式.md) | 模块依赖层次、package.json 依赖详解、5 种部署方式、API 端点、Guard 链、Cron、测试 | 部署、配置、日常开发 |

---

## 推荐阅读路径

### 新加入项目

```
00 项目总览 → 02 模块职责（快速扫一遍核心业务模块）→ 05 运行方式（本地跑起来）
```

### 排查某个 bug

```
00 启动流程（理解全局 middleware / guard 链）
  → 02 模块职责（定位到相关 module 的 Service）
  → 对应源码文件
  → 如需涉及数据层，转 03 数据库实体
```

### 新增/修改业务模块

```
02 模块职责（参考已有模块的结构和命名）
  → 03 数据库实体（如需新表，参考迁移脚本）
  → 05 开发速查（nest g / migration:generate）
```

### 修改更新机制

```
04 系统更新子系统（完整读一遍）→ 00 启动流程（理解 main.ts 的 mode 分派）
```

### 部署/升级

```
05 运行方式 → 04 系统更新子系统（理解维护栅栏、备份、回滚）→ 03 数据库迁移
```

---

## 快速参考卡

### 进程入口分派（`src/main.ts`）

```
node dist/main.js [args...]
│
├── --system-update-mode=<updater|worker|recover>  → updater 子系统
├── "self-test"                                      → native-self-test
├── "migrate" | "baseline" | "show-migrations"       → 迁移 CLI
└── 默认                                             → NestJS bootstrap
```

### 全局 Guard 链

```
DeviceThrottlerGuard → JwtAuthGuard → RbacGuard → Controller
```

### 核心目录

```
src/
├── main.ts              进程入口（模式分派）
├── application.ts       bootstrap（管道、CORS、维护拦截）
├── app.module.ts        根模块（全局 Guard/Interceptor）
├── common/              跨模块共享（guards/entities/middleware/utils）
├── database/            TypeORM 连接、初始化、迁移、SQLite 队列
├── migrations/          7 个手写迁移
├── modules/             21 个业务模块
└── updater/             系统更新子系统（独立进程模型）
```

### 核心运行命令

```bash
npm run start:dev              # 开发热重载
npm run build && npm run start:prod  # 生产运行
npm run db:migrate             # 执行迁移
npm run test                   # Jest 单元测试
npm run build:sea              # SEA 单可执行文件打包
```

### 核心环境变量（必填）

```
JWT_SECRET      JWT 签名密钥
ADMIN_PASSWORD  初始管理员密码
DATA_DIR        数据目录（默认 ./data）
DB_TYPE         sqlite | mysql | mariadb（默认 sqlite）
```

---

## 附录

- **源码仓库**：https://github.com/databk/rustdesk-console
- **前端仓库**：https://github.com/databk/rustdesk-console-web
- **许可证**：AGPL-3.0
- **Node.js**：≥ 20.0.0
- **Docker 镜像**：`databk/rustdesk-console`（Docker Hub）/ `ghcr.io/databk/rustdesk-console`（GHCR）
- **官方文档入口**：项目根目录 README.md + docs/ 目录（server-management、database-migrations、system-update、clone-isolation 等主题文档）

