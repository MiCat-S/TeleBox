# TeleBox 重写评估

状态：已选定 TypeScript + Node.js 24、新插件接口、systemd 托管，采用内存与响应速度均衡策略。
实施与验收计划见 [全量重写计划](REWRITE_PLAN.md)。此目录与生产运行入口隔离；
下文保留的跨语言验证记录仅为选型证据，不代表新的 TypeScript 核心已实现。

## 范围与验收

范围：两个仓库当前全部自有模块，以及其运行时、存储、面板、构建部署和辅助实现。
2026-09-05 源码盘点为 21 个内置入口、127 个主目录扩展入口及 3 个 outdated 历史入口，
合计 151 个入口。主目录含 126 项插件索引与未入索引的 sanitizeFileName；历史入口为
gemini、gpt、q。未安装、未入索引或位于历史目录都不构成遗漏理由。

生产 ai、da、dc、dme、gt、ids、ip、nodeseek、rate、sum、yvlu 仅决定首批迁移优先级。
全量重写不等于全量自动启用；保留安装和配置状态，各模块均须交付新接口实现与验收证据。
外部服务失效等阻碍逐项登记，不能据此静默删除能力或宣告全量完成。
inventory.cjs 动态扫描源码，标记模块类别、索引状态、生产优先级及辅助代码指纹。

| 阶段 | 必须交付的证据 | 当前状态 |
| --- | --- | --- |
| 技术选型 | 官方资料、固定版本、接口覆盖、构建成本及候选比较 | TypeScript + Node.js 24 已选定；资源收益待整机验证 |
| 关键链路 | 用户登录、重连/补差、历史分页、回复/编辑/删除、上传/下载、按钮、代理、取消 | 离线验证中；真实链路待验证 |
| 核心重写 | 权限、分发、背压、调度、生命周期、数据存储、面板的可运行实现与测试 | 新 TypeScript 核心尚未实现 |
| 插件迁移 | 全量入口逐项业务契约、配置迁移、相同输入输出比对 | 已扩展源码清单；完整插件及数据迁移未完成 |
| 功能回归 | 正常、异常、并发、限流、重载、恢复和权限负例 | 未开始 |
| 性能对比 | 同主机同负载的完整进程集合测量及原始结果 | 未开始 |

禁止以库 README 中的内存宣传值作为完整应用性能结果。
离线序列化或 mock 测试不能证明真实账号接入、跨 DC 上传或在线补差成功。

## 技术选型记录

以下为此前候选比较，不是实测性能排名。最终采用上方已确定的 TypeScript 路线与全量范围。

| 候选 | 适配路径 | 主要待证问题 |
| --- | --- | --- |
| Node.js / TypeScript + Teleproto | 保留基线，重写资源和生命周期管理；可直接复用 TS 插件 | 完整负载下优化空间；原生媒体库和辅助进程的峰值 |
| Go + gotd | 原始 MTProto、context 生命周期、编译期业务模块；JSON/SQLite 迁移 | 当前发布版 TL 覆盖、补差、跨 DC、语录渲染、JS 触发器兼容成本 |
| Python + Telethon | asyncio、动态模块；JSON/SQLite 迁移；NodeSeek 辅助逻辑有复用机会 | 当前 TL 覆盖、CPU 峰值、媒体依赖、取消与重载隔离 |
| Rust + grammers | Tokio、编译期模块、生成 TL 接口 | 新上游版本/API 稳定性、完整迁移维护成本、工具链与构建耗时 |
| 原生宿主 + TDLib | C/JSON 接口及 TDLib 数据库与更新处理 | 原始 RPC 的逐项功能等价映射、账号会话导入、构建与全进程占用 |

此前 Go/Python 探针验证可复用的协议及业务契约，不作为后续主体实现。

## 业务迁移策略

全部自有模块迁移到新的 TypeScript 插件或核心接口；业务契约、测试素材和数据可复用。
不保留旧插件接口直装承诺。第三方依赖及 vendored 代码保持来源和许可证，按需求适配验证。

| 模块 | 重写与验收重点 |
| --- | --- |
| ai | 重写协议适配与生命周期；保留提供商、模型、提示词、超时、reasoning/service tier、图片/视频、长文输出契约 |
| gt | 重写薄命令入口；仍复用 ai 翻译服务；中英、回复、转义、分段和取消 |
| sum | 重写历史采集、独立提供商与调度；保留任务 ID、来源链接、提示词、去重、时区 |
| da | 重写搜索和批量删除；权限检查、数量/范围、进度、失败恢复 |
| dme | 重写个人/频道身份筛选、媒体编辑和删除流程；不得扩大可删除对象 |
| ids / dc | 重写实体查询与信息格式化；大整数 ID、access hash、可见性错误 |
| ip / rate | 适配 HTTP 请求、缓存、代理及格式化；复用接口语义和测试素材 |
| nodeseek | 重写调度和通知状态；保留 Cookie、游标、随机签到窗口；curl_cffi 子进程计入成本 |
| yvlu | 重写 TG 适配；评估字体、头像、引用、图片渲染与贴纸集合操作；图像做视觉回归 |
| help / prefix / alias / re / debug / ping | 重写命令适配；保持命令解析、实体 ID、回复/话题行为 |
| sudo / sure | 逐分支迁移权限、对话/消息白名单、重定向；以旧代码为契约，增加拒绝路径测试 |
| tpm / update / reload | 重写包格式、安装/更新与生命周期；明确源码插件、编译模块和兼容插件的安装差异 |
| bf / switch | 重写备份、恢复、版本迁移；验证跨运行时会话，不沿用不可用的旧启动器 |
| memory / loglevel / sendLog / exec | 重写运行时相关部分；保留监控、日志脱敏和授权边界 |
| kitt | 保留用户 JavaScript 触发器语义及权限；执行资源纳入新生命周期管理 |
| agent | 重写提供商、会话、工具执行及平台适配；盘点所有工具和外部进程 |
| leech | 重写分页/抓取/恢复，优先保持 SQLite schema、消息序列化和任务游标兼容 |
| panel | 优先复用静态 HTML/CSS/JS；适配后端路由、initData 验签、会话、owner/admin 权限及插件表单 |
| 其余主目录及历史扩展 | 按 inventory.cjs 全量清单逐项重写；补齐命令、监听、调度、配置、辅助进程和正常/异常行为证据 |

## 数据与回退契约

1. 仅读取源码和合成数据进行初期验证，不将生产 Session/API Key/Cookie 写入实验报告。
2. 迁移器读取副本、写入新目录，带版本清单与校验值；先 dry-run，旧目录保持不变。
3. JSON 保留未知字段；SQLite 先验证 schema、行数、主键、关联和大整数精度，再逐条比对。
   不把 JSON 中的 Telegram ID 转为有精度损失的浮点数。
4. 会话必须分别验证 DC、地址、端口、auth key 的合成往返，以及授权后的真实登录。
   Teleproto StringSession 与 Telethon StringSession 编码不同，不可直接假设通用。
   现有 versionSwitchSessionConvert.ts 委托另一仓库，不能当作通用迁移器。
5. 生产切换前明确暂停旧调度、记录游标、备份、启用新实例；禁止双实例同时签到或删除消息。
6. 回退使用旧二进制/运行时与旧数据；切换后新增配置、任务与游标必须提供反向迁移或变更日志，
   不能只恢复旧快照而静默丢失新数据。
7. 真实账号登录、外部 AI 请求、发消息/删除/签到、生产切换、提交推送分别执行授权门禁。

## 性能验收协议

- 同一 Linux 主机、固定 OS/CPU 配额、运行时/依赖/源码版本、配置、插件、字体和媒体样本。
- 功能回归通过后才比较完整系统；HTTP 录制回放用于可重复负载，另做授权在线测试。
- 同时验证生产插件集合与全库功能负载矩阵；互斥或命令冲突的模块分组测试，每组新旧集合一致。
  模块全部纳入迁移验收，不要求把所有自动化规则同时启用。
- 场景：冷启动；预热后空闲；普通消息分发；历史分页与摘要；并发 AI/翻译；
  语录渲染/上传；批量清理；NodeSeek fallback；面板访问；重载；网络断开与补差。
- 每场景记录次数、预热时间、持续时间、输入种子、并发度；至少重复五次。
- 同时报告 cgroup 总内存/峰值、各进程 RSS/PSS、CPU 时间、吞吐量、p50/p95/p99 延迟、
  错误/丢失/重复率、启动耗时和安装产物大小。共享页不能简单相加当作独占内存。
- 兼容 Node、Python、Cloudflare Tunnel、图像/视频子进程全部计入；不能转移负载到未测进程。
- 首轮测量建立正式基线，按 REWRITE_PLAN.md 的资源及响应约束验收；未测数据写“未测”。

## 复现

在 TeleBox-Core 目录：

```sh
npm --prefix rewrite-lab ci --ignore-scripts --no-audit --no-fund
npm --prefix rewrite-lab test
node rewrite-lab/inventory.cjs
go -C rewrite-lab/go-probe test -v ./...
python3 -m venv rewrite-lab/.venv
rewrite-lab/.venv/bin/pip install -r rewrite-lab/requirements.txt
rewrite-lab/.venv/bin/python rewrite-lab/telethon_probe.py
rewrite-lab/.venv/bin/python rewrite-lab/storage_probe.py
rewrite-lab/.venv/bin/python rewrite-lab/transport_probe.py
```

清单用 TypeScript AST 读取源码，不执行插件、不读取 assets。
静态清单不是完整 API 覆盖证明，动态命令、助手调用和数据路径需要逐项补充。
评估目录单独固定 TypeScript 5.9.3 作为 AST 解析工具；主体的 TypeScript 7.0.2
安装包未提供这里需要的 createSourceFile/ScriptTarget API。主体依赖与锁文件未修改。

## 首批实测结果

2026-09-05，本机 macOS arm64，Go 1.26.6、Node 26.7.0；不是生产 Linux 性能测试。

| 验证 | 结果 | 证明范围 |
| --- | --- | --- |
| 静态清单 | 2/2 测试通过 | 内置插件与 11 个扩展均纳入，能识别指定 RPC 与子进程依赖 |
| gotd v0.161.0 | 4/4 顶层测试通过，含 IPv4/IPv6 子用例 | 合成 Telethon 格式会话导入、原生存储往返、畸形会话拒绝、7 类 RPC 编码、旧按钮载荷往返 |
| Telethon 1.44.0 | 3/3 测试通过 | 现有 Teleproto 生成的合成会话经显式解析后导入，7 类 RPC 编码、旧按钮载荷 |
| 协议层 | gotd 228；Telethon 227；现有 Teleproto 229 | 直接读取固定版本库代码/运行时常量；仍需功能等价验证 |
| Rust / TDLib | 官方资料初筛；未构建 | 无运行性能或接口完整性结论 |
| 在线链路及完整系统资源 | 未测 | 不能据此确定最终技术栈 |

7 类 RPC 是 GetHistory、EditMessage、DeleteMessages、GetSendAs、
GetBotCallbackAnswer、SaveFilePart、GetState；没有发送至 Telegram。
Go 的会话探针使用独立构造的合成 Telethon 格式，尚未串联 Teleproto 转换；
Python 探针确实调用当前 Teleproto 的 StringSession.save 生成合成数据。
探针不是生产迁移器，未覆盖真实 auth key、授权状态、全部格式及逆向迁移。

下一批验证顺序：

1. 补全助手方法、权限分支、动态命令、Agent 工具、面板路由和数据 schema 清单。
2. 在已构建的固定候选版本上扩大接口覆盖，验证低 Layer 下的业务等价映射，
   补全 Rust/TDLib 会话迁移路径。
3. 测试事件顺序、取消、重载、定时任务去重、代理和合成数据完整往返。
4. 明确测试账号、允许的测试对话及外部调用范围后再进行真实链路验证。
5. 用上述证据作技术决策，之后推进完整核心和插件重写。

## 第二批验证

- `permission-cases.json` 保存 25 个合成 sudo/sure 样例，测试执行现有完整插件模块，
  替换数据库和发送接口；另有 5 个解析、分发及面板权限测试。连同原清单测试共 32 项通过。
- 主命令分发仍按 `out || savedPeerId` 进入；别名按最长匹配展开且不修改原消息；
  `ignoreEdited` 插件不响应编辑事件。这些测试记录基线行为，不是对全部授权路径的安全证明。
- sudo 必须命中用户名单；对话名单为空时不限制对话。sure 还必须命中消息规则，
  `_command:` 边界接受空后缀或 ASCII 空格，不接受前缀碰撞或制表符；规则按首个匹配执行。
- 面板 owner 与附加管理员分离，写接口只允许 owner；签名 token 有效但用户已被撤权时，
  `requireSession` 拒绝访问。测试覆盖路由分类和会话检查函数，尚未覆盖真实 HTTP 全路径。
- SQLite 测试通过现有 AliasDB/SudoDB/SureDB/SendLogDB/LeechDB 类创建五个临时库，
  Python SQLite 读取并执行备份/回退，比对 schema、行和完整性；原文件哈希不变。
  验证保留 `9007199254740993`、BLOB、NULL 和未知表，不能据此声称所有业务读取器均支持该整数。
- 在线备份另行验证 WAL 已提交记录。离线 `immutable=1` 路径只用于已关闭且无附属文件的
  合成快照，发现 `-wal` 或 `-shm` 会拒绝；不允许将该路径用于活跃生产库。
- 本机只读 WAL 检查在没有附属文件时失败，读写连接建立附属文件后可读。
  此环境观察不代表数据库格式不兼容；尚未定位为何没有自动创建附属文件。
- 既有 `cronManager.test.ts` 和 `generationContext.test.ts` 共 6 项复测通过，
  覆盖重叠执行抑制、同步失败释放运行标记，以及任务结束期间/之后注册资源的清理。
  候选运行时的对应实现尚未验证，不能把基线测试结果算作重写通过。

### 原生构建

工具链和源码放在 `.tools/`，不修改全局 PATH。Rust 固定 1.98.1，grammers 固定 0.10.0，
Cargo.lock 已保存。Rust 的真实高层库编译、7 类 RPC 编码和按钮二进制往返共 3 项通过；
生成协议 Layer 为 227，尚未验证 Rust 会话迁移和在线行为。

grammers-crypto 0.10.0 声明 `glass_pumpkin 2.0.0-rc0`，首次依赖解析选中 rc1 后出现
BigUint 类型和 bool/Result 返回类型不兼容；实验显式固定 rc0 后构建成功。
这项兼容约束属于候选的维护成本，不是加密安全审计结论。

TDLib 固定提交 `d1085f9cebc5a62379991ae1652673954f229c1f`，CMake 包版本 1.8.67。
其 JSON ABI 是高层 TDLib API，不能直接传入原始 MTProto 构造器；历史、编辑、删除、
发送身份和回调有对应高层方法，但数据表示、分页和错误语义仍需业务等价测试。
原始 auth key 导入路径尚未确定，不能把列出/确认 session 的管理接口当成会话导入接口。
`td/telegram/MessageId.h` 中普通服务端消息 ID 使用左移 20 位的内部表示，
另有本地与定时消息类型；既有 leech 记录、来源链接、回复和删除参数必须在边界显式映射，
不能直接用 TDLib 消息 ID 覆盖原始 MTProto ID，也不能对所有 ID 无条件移位。

本机复现原生构建（首次执行 prepare；已有目录需先检查状态）：

```sh
cd rewrite-lab
node prepare-native.cjs rust
node prepare-native.cjs tdlib
env RUSTUP_HOME="$PWD/.tools/rustup" CARGO_HOME="$PWD/.tools/cargo" .tools/cargo/bin/cargo test --locked --manifest-path rust-probe/Cargo.toml
cmake -S .tools/tdlib -B .tools/tdlib-build -DCMAKE_BUILD_TYPE=Release -DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3 -DZLIB_ROOT=/opt/homebrew/opt/zlib
cmake --build .tools/tdlib-build --target tdjson --parallel 2
.venv/bin/python tdlib_probe.py
```

TDLib Release 动态库构建成功，3 项 JSON ABI 探针通过：HTML 实体解析、无效 HTML 拒绝、
异步请求关联/字节回传/正常关闭。探针只调用文本解析和无需账号参数的请求，并等待关闭状态；
没有调用 `setTdlibParameters`，没有登录或消息收发。

本轮复测结果：Node 评估 32/32、gotd 4/4、Telethon 3/3、Rust 3/3、
SQLite 3/3、TDLib 3/3，另有现有调度/生命周期基线 6/6。
各测试覆盖面不同，不构成候选能力排名；未重跑全部生产回归套件，也未测完整应用资源。

下载校验记录：rustup-init SHA256
`ec1b9233e7f72990ecd8e62063fa7f6c3dfc2bec8e97f88bff165f9100ac696a`（比对官方 sha256 文件）；
TDLib 固定提交源码归档 SHA256
`ba44c6eedc321b50082045167554e4a01c01f321cedd54c3cccc2beff8e4c78d`（下载记录）。

## 第三批验证

- Go 现有 Teleproto -> gotd 合成会话字段导入和本地 Session Loader 往返通过，
  覆盖 IPv4/IPv6、DC、端口、auth key 和派生 key ID；这取代首批仅手工构造 Telethon 格式的证据缺口。
  测试桥接器不是生产迁移器，未处理所有历史格式或验证真实授权状态。
- Go `telegram.Client.Run` 连续 10 轮在待拨号阶段取消，拨号任务退出，ready 回调不触发；
  已关闭客户端拒绝复用。所有拨号均被测试函数截获，没有拨号到 Telegram。
  新实例代表下一运行代次；不代表已经实现应用重载或补差。
- Go 探针现在 7/7，通过 `go test -race -count=1 -timeout=30s ./...`。
  数据竞争检查只覆盖这些测试路径，不是对整个应用的证明。
- Telethon 传输层在本地 SOCKS5 服务完成合成用户名/密码认证、目标地址协商，
  连续 5 轮连接与断开后收发任务结束、socket 关闭；待连接取消另行通过。
  2/2 测试通过。代理仅监听回环地址且不转发，未证明生产代理/TLS/MTProxy 可用。
  依赖固定 `python-socks[asyncio] 3.0.0` 和 `async-timeout 5.0.1`。
- Rust 现有 Teleproto 合成会话解析并导入 grammers MemorySession 的字段验证通过，
  含 IPv4/IPv6、DC、端口与 auth key；共 4/4 探针通过。MemorySession 不持久化，
  不能将此结果视为完成磁盘会话迁移。新增 grammers-session 默认特性包含 libsql，
  Cargo.lock 记录相关构建依赖；本轮未测其运行内存或数据库迁移。

当前仍缺：候选应用级调度/背压/重载、真实 MTProto 关键链路、媒体和 AI 适配、
完整配置/会话切换回退，以及同功能负载下的全系统性能对比。不得以本轮测试数量替代这些门禁。
在线验证需用户指定测试账号与私有测试群并明确允许的消息操作；不自动复用生产会话。

## 第四批验证：候选生命周期

`go-probe/lifecycle` 提供独立候选实现，尚未接入生产或确定最终语言：

- 跟踪任务与资源，停止后拒绝新任务；关闭回调最多执行一次。
- 排空期间和排空后注册的资源立即启动清理，并保持可查询的追踪状态。
- 调用方的排空期限不代表强制终止 Go 代码；未退出任务与未结束清理回调
  在超时报告中保留，后续排空可重新验证。
- 普通任务错误记录在 `TaskErrors`，不阻止资源排空成功；清理错误记录在
  `Errors` 并使 `Completed` 为 false。`Disposed` 仅表示任务/清理回调已结束，
  不等于清理操作全部成功，调用方必须检查 `Completed` 和错误列表。
- 任务内通过自身上下文调用 `Drain` 会被拒绝，应使用 `RequestStop`，
  由外部协调器等待排空。丢弃任务上下文后无法自动识别自等待。
- 9 项生命周期测试通过数据竞争检测，重复 20 次；覆盖并发准入/停止、
  并发关闭、嵌套及晚注册资源、任务与清理超时、错误与 panic、任务内停止。
- gotd 真实客户端在该原型中连续 10 代于待拨号阶段取消，排空后活动拨号为零，
  没有待结束任务。自定义拨号器拦截全部网络连接，未验证登录后的更新/补差。
- 完整 Go 探针 `go test -race -count=1 -timeout=60s ./...` 通过：
  根包 8 项、生命周期包 9 项。其他语言探针本批未重跑。

本批尚未实现应用重载协调器、任务背压、定时调度及插件集成。当前错误记录随代次累积，
长期运行前须实现有界诊断存储与持久化策略；尚未进行资源占用测试。
父上下文取消会停止任务并拒绝新任务，外部协调器仍须调用 `Drain` 完成资源清理。
这些结果不构成完整核心验收或技术栈选型结论。

## 第五批验证：候选重载协调器

`go-probe/lifecycle/supervisor.go` 实现串行代次切换，使用上一批生命周期原型：

- 旧代次 `Drain.Completed` 为 true 后才启动新代次。并发重载按串行请求处理，
  不合并请求；测试 20 个并发请求的服务计数始终不超过 1。
- Setup 作为被追踪任务运行，返回成功代表初始化完成；后台服务必须通过
  Generation 注册任务和资源。尚未提供 Telegram 登录就绪适配器。
- 启动失败时清理已注册资源；失败实例保留在 `Current()` 中供检查。
  清理出错或超时阻止替换，超时任务完成后可重试；清理错误不自动忽略或重试。
- 排队的控制操作可取消；任务内携带自身上下文调用 Stop/Reload 会在等待锁前拒绝。
- 重载请求上下文只约束该次切换，成功启动的服务归属 Supervisor 父上下文。
  父上下文取消后不再报告 ready，但外部所有者仍须调用 Stop 排空资源。
- 新增 9 项协调器测试；生命周期包共 18 项在 race 模式重复 20 次通过。
  完整 Go 探针共 26 项通过 `go test -race -count=1 -timeout=60s ./...`，
  `go vet ./...` 通过。本批没有网络操作，没有测性能。

这是候选控制层，尚未完成命令触发重载、插件装载、背压、调度器或持久化更新游标。
生命周期边界内的安全性依赖所有后台工作被正确注册；未追踪的外部资源不在保证范围内。
仍未作最终技术栈选择，完整功能与性能验收状态不变。

## 第六批验证：候选有界执行器

`go-probe/lifecycle/executor.go` 用固定数量的 Generation 工作任务消费固定容量环形队列。
Submit 不创建 goroutine，容量限制仅涵盖本执行器内的运行任务和排队任务，
不涵盖调用方或任务自己创建的后台工作。

- 队列满返回 `ErrQueueFull`，停止后返回 `ErrStopped`；调用方必须决定重试、
  持久化或明确反馈。尚未接入 Telegram 更新确认/补差，不能证明不丢消息。
- 每个被接受的任务有独立结果通道；停止时排队任务收到 `ErrStopped`，
  已运行任务收到代次上下文取消信号，其实际返回值仍会交付。
- 任务 panic 转为该任务结果，不退出工作循环。任务错误由调用方消费，
  不累计在 Generation 的工作循环错误中；尚未接入生产日志/诊断存储。
- 工作任务本身被 Generation 追踪；不响应取消的任务会阻止代次排空和替换，
  不以队列清空作为资源已释放的证据。
- 6 项新增测试覆盖队列满、排队取消、并发请求结果核对、panic 后继续处理、
  未退出任务阻止重载、非法容量，以及实际并发峰值不超过指定的 3 个工作任务。
  生命周期包共 24 项，race 模式重复 20 次通过；完整 Go 32 项及 go vet 通过。

尚未提供按对话顺序、任务优先级、每任务单独取消、持久队列或公平调度契约。
下一步需根据原插件的命令、监听器和定时任务语义接入，而非把所有消息
简单投入该队列后忽略拒绝结果。本批没有性能测量、插件迁移或生产改动。

## 第七批验证：定时表达式差异

候选调度解析器固定 `github.com/robfig/cron/v3 v3.0.1`，通过 Go 模块查询
确认该发布版；仅在评估模块增加依赖。配置可选秒字段和描述符，仍不能直接替换旧库。
`cron-fixtures.cjs` 调用当前核心实际安装的 `cron`，不加载用户配置或执行任务；
Go 的 `TestCronCompatibilityAudit` 对照 12 组合成表达式、起点和时区。

| 已复现差异 | 基线行为 | 候选行为 |
| --- | --- | --- |
| `0 0 15 * 0-6`，UTC，2026-09-01 后 | 下一次 09-15 | 下一次 09-02 |
| `0 0 * * 7` | 接受星期日 7 | 拒绝大于 6 的星期值 |
| `30 2 * * *`，纽约，2026-03-08 跳时 | 当天 03:00 | 次日 02:30 |
| `30 1 * * *`，纽约，2026-11-01 重复小时 | 当天只执行一次 | 两个 01:30 均执行 |

第一项根因已检查实际源码：旧库按字段覆盖数量判断星期限制，robfig 按解析器的
通配符标记判断日期/星期的 AND 或 OR。夏令时差异通过实际日期输出确认，尚未实现兼容适配。
普通五/六字段、工作日、日期与星期组合、两次闰日、周描述符和两个非法输入样例的
结果一致；这不是表达式语义的穷尽证明。每个有效普通样例比较两个连续触发时间。

审计测试明确固定上述不兼容结果，绿色表示证据可复现，**不表示定时迁移通过**。
完整 Go 测试和 go vet 通过；新增一个顶层审计测试包含 12 个子用例。
初次用三个连续闰日触及旧库相对当前时间的八年搜索上限，当前样例限制为两个，
该边界未作为生产兼容能力通过。

后续需要用生产配置副本核对所有表达式与时区，并实现经过对照验证的兼容适配，
或在用户批准后显式迁移受影响的调度规则。不能静默改变执行时间或重复执行次数。
默认时区亦须从现有部署核验，不能由本机 Asia/Shanghai 推断服务器时区。
当前未接入新调度器，NodeSeek 随机窗口和摘要任务游标仍待迁移。

## 第八批验证：定时字段编译桥接

`compile-cron.cjs` 用基线实际 cron 解析器生成版本化记录，保留原表达式、显式时区、
解析器版本和六字段规范表达式。数值全集转换为通配符，星期日 7 由旧解析器解析为 0；
范围、步长、命名月份/星期和预设均复用旧解析器，不重新手写语法。
`go-probe/schedule.Compiled.ParseFields` 验证记录格式并用 robfig 读取解析结果。

- 新增星期范围、步长及完整日期范围样例，原始对照和编译后对照各 15 个子用例。
  编译后星期日 7、5-7、1-7/2，以及完整日期/星期范围样例均与基线日期一致。
- 跳时和重复小时两类差异仍在编译后对照中明确报告 UNRESOLVED，尚未解决；
  ParseFields 返回的仍是原生 robfig 日期计算器，不可用于声称全兼容。
- 编译器 2 项测试，Go 记录校验 8 个负例通过；Node 评估套件 34/34、
  Go 全部测试（race）和 go vet 通过。本批没有生产配置或账号操作。

已编译规则可由 Go 独立读取，不需要常驻 Node 参与日期计算。编译过程仍依赖
基线 Node/cron；新增和编辑规则的面板/命令入口尚未迁移，所需编译执行成本
必须纳入最终部署与性能评估。该桥接器是候选迁移组件，不是完整配置迁移器，
尚未包含文件清单、持久化写入、校验和或反向迁移流程。

## 第九批验证：本地日历日期适配

`schedule.WallSchedule` 将规范化字段交给 robfig 在 UTC 表示的本地日历上匹配，
再用 Go 时区区间解析实际时间点。没有重写 cron 字段搜索器。
时区解析检查候选日期前后 48 小时的 ZoneBounds，匹配有效偏移，并处理不存在的
本地时间；无未来匹配或无法前进时返回错误。该区间不是全部历史时区规则的证明。

- 纽约一小时跳时/回拨、跳时秒值、悉尼跳时/回拨的两个连续结果与基线一致。
  原始 robfig 和仅编译字段的差异审计继续保留，区别于本适配层结果。
- 扩展到 Lord Howe 半小时夏令时后仍有差异：02:15 跳时样例基线返回当地
  01:45，适配层返回 02:45；01:45 回拨样例基线返回 01:15，适配层返回 01:45。
  这些基线输出偏离表达式时分，尚未决定按旧行为兼容还是显式迁移规则。
- `TestWallCronCompatibilityAudit` 的 20 个子用例包含上述两个已知未解决差异，
  绿色仅表示复现记录准确；不是定时迁移验收通过。其他有效样例逐个比较两次日期。
- Luxon 解析歧义时间会用当前偏移作为参考。测试子进程固定其参考时间为
  `2026-09-05T00:00:00Z`，记录在输出中，避免测试随季节改变；生产时钟未改动。
- 新增前进性测试（包括回拨第二次小时内的起点）和无日历匹配错误测试；
  全部 Go race 测试及 go vet 通过。前进性测试不是这些起点与旧库一致的证明。

当前适配仍未接入任务调度。半小时转换、歧义时间依赖参考季节、历史/特殊时区、
搜索期限差异仍需验证和迁移决策；也未完成生产规则集合的覆盖检查。
下一步可并行推进与日期计算解耦的调度生命周期、去重及执行结果处理。

## 第十批验证：定时任务执行生命周期

`schedule.StartJob` 接受独立的 NextDate 接口和业务 handler，启动被 Generation 追踪的
定时循环；每次执行另行追踪。此次测试使用合成日期提供器，不把尚未验收的日期适配
自动用于业务任务。

- 同一 Job 已有执行在运行时跳过新一轮，并记录 Started/Finished/Skipped/Failed。
  handler 返回错误或 panic 后释放运行标记，后续触发可以执行。
- Stop 的准入边界由互斥锁保护；停止后不再接纳新执行。此前已接纳但尚未开始
  handler 的执行仍属在途任务。Stop/Done 只表示停止定时循环，不代表 handler 完成。
- 单个 Job 停止不会取消已经接纳的 handler，与基线 del 停止未来触发的行为相符；
  Generation 停止会向 handler 传递取消信号并等待它真正结束。
- 日期提供器返回错误、panic 或非未来时间时循环停止并暴露 LastError，
  不进行快速重试。同步日期提供器自身若不返回，仍须由代次排空超时报告追踪。
- 新增 5 个顶层测试，使用 Go testing/synctest 虚拟时间，涵盖重叠跳过、停止前后
  在途任务、异常恢复、代次取消、非法日期和首次触发前停止。调度包 race 重复
  20 次通过，完整 Go race 测试及 go vet 通过；虚拟时间不是性能测量。

当前是单任务执行层。命名任务注册/删除、重复名称规则、队列背压策略、
NodeSeek 随机延迟、sum 游标持久化、进程重启后的恢复仍未接入。
Job 只保存最近错误和累计数量，完整错误诊断仍依赖代次记录，长期有界存储尚待实现。
本批未修改生产，也不构成完整调度模块或插件迁移验收。

## 第十一批验证：命名任务注册与重载

`schedule.Registry` 按代次管理命名任务，支持 Add/Remove/Snapshot/Close。
重复注册返回 ErrDuplicate，保留首个任务；调用方需将结果映射到命令或面板提示。
注册句柄 Close 按实例身份删除，旧句柄不会误删同名替代任务。

- 50 个并发同名注册仅一个成功；重复名称不替换 handler。
- 删除后可以重新注册；旧句柄重复关闭不会影响新任务。
- 删除只停止未来触发；在途 handler 仍由 Generation 追踪并在代次停止时取消。
- 注册表关闭后拒绝新任务；代次的资源清理自动关闭注册表。
- 与 Supervisor 连续 5 代切换的虚拟时间测试通过：旧注册表清空、旧任务停止触发，
  新代次的同名任务正常执行。测试 handler 只更新内存计数，不是 sum 业务迁移。

新增 5 项测试；调度包 race 重复 20 次、全部 Go race 测试及 go vet 通过。
当前尚未接入真实插件、持久化配置/游标或跨进程去重；也没有完整系统性能结果。
后续应推进业务命令与权限适配，避免仅以基础设施测试数量作为重写完成证据。

## 第十二批验证：命令权限决策

`go-probe/command` 提供纯函数命令解析与 sudo/sure 发送决策，尚未执行 Telegram I/O：

- 保留首个前缀、最长别名、ASCII 命令名及 JavaScript 空白字符划分；
  sudo 独立前缀覆盖、用户/对话白名单、转发拒绝、回复/话题目标。
- sure 保留首条规则优先、精确消息和 `_command:` 的 ASCII 空格边界、
  重定向后命令解析及 5000ms 删除决策。
- 实际旧源码使用字符串 replace，重定向中的 `$$`、`$&`、`$'`、`$\``
  有替换语义；补充相同实现和 4 项共享回归样例，包括空替换结果的回退行为。
- 同一份权限样例共 29 项：Node 执行实际旧插件源码，Go 执行候选决策函数，
  均与共享期望一致。Node 评估 38/38、全部 Go race 测试和 go vet 通过。
- 候选 ID 使用规范十进制字符串，额外验证超过 JS 安全整数范围的相邻值不混淆。
  这不是旧库大整数行为等价证明，实际 Telegram peer 提取和数据库转换仍待适配。

决策包含发送文本、命令、回复目标、实体复制标记和删除延迟；未实现实际发送失败处理、
发送后分发、权限配置增删/缓存、数据库读取或消息删除。主账号入口判断、
别名参数展开、编辑消息策略和面板权限也尚未迁移到候选业务入口。
本批不构成 sudo/sure 完整插件迁移或安全审计结论，生产未改动。

## 第十三批验证：主账号命令分发

`command.Dispatcher` 提供按代次创建的路由快照，复制前缀、别名索引和处理器映射。
Primary 只接纳 Out/Saved 标记的消息，再应用命令解析和 IgnoreEdited。
Dispatch 支持委托调用入口，保留独立的触发消息引用，并按旧源码规则展开别名参数。

- 消息归一化字段按值传递，别名展开只改变副本 Text，保留用户/对话/话题/回复字段。
  Native 原始载荷只读保留，不克隆底层 Telegram 对象；后续业务必须读取归一化 Text，
  不能误从 Native 读取未展开的旧文本。
- 处理器错误向上返回，由尚未实现的传输适配层负责日志和 Telegram 错误回显。
  当前不等同于旧版 catch 后 edit 的完整错误处理路径。
- 新增 5 项测试：主账号/收藏夹与编辑策略组合、别名参数和来源保留、
  路由快照独立性、未知命令/错误/取消，以及通过 Generation Executor 调用后的取消排空。
- Node 旧源码对照套件 38/38，全部 Go race 测试及 go vet 通过。

仍未接入真实 gotd 更新对象、业务插件实例、sudo/sure 的发送后分发与延迟删除。
该实现不宣称原 TS 插件可以直接加载，也没有完整系统性能数据；生产未改动。

## 第十四批验证：gotd 消息类型接入

`telegramio.NormalizeUpdate` 适配固定版本 gotd 的 UpdateNewMessage、
UpdateNewChannelMessage、UpdateEditMessage、UpdateEditChannelMessage，
输出命令 Envelope 并保留原始 tg.Message，供后续发送/实体处理使用。

- 编码和解码后的四类更新已进入候选 Dispatcher，验证编辑过滤和处理器调用。
- 保留发出/收藏夹/转发标记、原始十进制 peer ID、普通回复和论坛话题根消息。
  转发头读取实际 TL flags，不通过空结构值猜测其是否存在。
- 用户、普通群和频道的原始 ID 与现有 sudo/sure 数据库约定对照；不把频道 ID
  静默转换为 -100 标记形式。Peer 类型仍保留于 Native，发送时须结合类型和 access hash。
- 未提供 sender 时不猜测用户；服务消息和非目标更新返回明确的非匹配错误，
  不隐式确认或更新 PTS。Short updates、容器、补差和其他事件还需单独接入。
- 新增 4 项顶层测试，含四类更新、三种 peer、回复/话题组合、精确大整数及
  转发拒绝；适配包 race 重复 20 次、全部 Go race 测试及 go vet 通过。

这是离线真实库类型/序列化验证，不是线上消息收发验证。仍未接入 updates.Manager、
peer 缓存、真实发送/编辑/删除、更新游标持久化或账号登录；生产未改动。

## 第十五批验证：更新投递与检查点故障边界

检查固定 gotd v0.161.0 的 `updates/state_apply.go`，发现 applyPts 在业务处理器
返回错误后记录日志，仍调用 SetPts。使用真实 updates.Manager、合成 API 和内存
StateStorage 复现了两项风险：

- 初始 PTS=10，投递 PTS=11 的普通删除更新；处理器返回 ErrQueueFull，
  存储游标仍变成 11。同一更新再次送入 Manager，不会重试处理器。
- 处理器成功但 SetPts 注入写失败，存储仍为 10；同一进程中重放该更新仍不会
  再调用处理器，说明持久检查点失败不意味着内存序列退回。

测试通过代表风险已复现，不代表可靠投递实现。两项测试在虚拟时间隔离环境运行，
没有实际网络连接；适配包 race 重复 20 次、全部 Go race 测试和 go vet 通过。
普通 PTS 路径的证据不能推广为所有频道/QTS/补差路径均已验证。

因此不得把 Executor.Submit 的拒绝结果直接返回给 Manager 并当作重试机制。
后续需要持久化业务收件队列、可恢复的处理状态和检查点故障边界：入队持久化之前
不能把业务事件当成已接纳；写入失败后要阻止后续检查点越过缺口并停止/恢复运行代次。
恢复也不能只将原事件重新送给已推进内存游标的 Manager。
上述机制尚未实现，不能宣称不丢消息或仅执行一次；生产未改动。

## 第十六批验证：SQLite 业务收件队列

`go-probe/inbox` 提供独立的持久事件存储，使用 `database/sql` 和固定
`github.com/mattn/go-sqlite3 v1.14.52`。已查询发布元数据、检查官方文档并实际构建；
该驱动需要 CGO/C 编译工具链，必须计入后续部署成本，尚未确定最终数据库驱动。

- 专用数据库采用 WAL/FULL 同步和事务；Put 提交成功后才返回。
- 账户与调用方提供的事件 key 共同唯一。相同载荷重放返回同一序号，
  相同 key 不同载荷返回冲突；已完成记录保留用于去重。
- Pending 按序号读取并校验载荷 SHA256；Complete 显式确认，未知序号报错。
- 对保留载荷总字节数设配额，已完成记录也计入；这不限制数据库物理文件、
  key/索引或 WAL 大小。当前汇总配额为查询计算，未做性能优化或容量规划。
- 5 项业务测试覆盖重开、去重/冲突、账户隔离、配额/取消、双连接并发、读取校验
  和关闭后写入拒绝。另有子进程辅助测试：提交后不调用 Close 直接退出，父进程读回
  事件。全部 Go race 测试通过；这不是断电/磁盘故障恢复证明。

Pending 尚不是租约领取接口，当前只允许一个业务消费者。处理后、确认前崩溃会导致
重放，外部操作幂等性仍待实现；不能宣称 exactly-once。生产 Telegram 事件 key 规则、
编辑事件身份、载荷编码版本、保留/清理策略、检查点保护及 Manager 接入也尚未完成。
所有测试使用临时合成数据库，未读写生产业务数据。

## 第十七批验证：入队与检查点故障保护

`telegramio.FailureFence` 按 Manager 生命周期串行保护持久入队和检查点写入，
首次错误或 panic 后保留故障、取消该代次上下文，后续操作返回同一故障。
`CheckpointStorage` 包装 StateStorage 的全部七个写接口；读取仍可用于检查状态。
只包装存储不够，业务入队必须使用同一 FailureFence。

- 真实 Manager + 临时 SQLite 的普通 PTS 集成测试覆盖正常入队、配额拒绝和
  检查点写失败。正常场景 PTS 10 -> 11 且载荷可解码；配额失败时 PTS 保持 10，
  Manager 退出；检查点失败时 PTS 保持 10，但已提交的业务事件仍在收件队列。
- 故障后的 SetState/Pts/Qts/Date/Seq/DateSeq/ChannelPts 均被拒绝；panic 也触发故障。
- 新增 3 个顶层测试，其中集成测试含 3 个场景。适配包 race 重复 20 次、
  全部 Go race 测试及 go vet 通过；测试没有真实 Telegram 连接。

保护层不重置 gotd 的内存序列，恢复必须新建 Manager 并读取持久检查点。
本批检查点仍使用测试存储，尚未实现生产持久 StateStorage 或自动恢复协调。
集成测试只使用一个固定合成 key，不能直接作为生产事件身份算法。
频道/QTS/补差并发、checkpoint-before-dispatch 路径、账户启动状态、崩溃重放和
外部副作用幂等性仍需逐项验证，不能据此宣称全路径可靠投递。生产未改动。

## 第十八批验证：持久检查点与 Manager 重建

SQLite Store 实现 gotd StateStorage、ChannelAccessHasher、UserAccessHasher，
按账户隔离保存 PTS/QTS/date/seq、频道 PTS，以及区分 user/channel 的 access hash。
部分字段写入在账户不存在时返回错误，不隐式创建不完整状态。

- 实验数据库 schema 1 -> 2 在事务中新增三张表，保留收件队列载荷、序号及完成状态；
  合成旧版数据库升级验证通过。旧版实验代码不认识 schema 2，尚未实现反向迁移，
  实际迁移应在副本上进行并保留旧版数据，不能把这次升级当作生产回退方案。
- 重开恢复账户状态、频道状态与 hash，精确保留 int64 大整数和负 hash；
  账户及 peer 类型隔离通过测试。
- ForEachChannels 先读取结果并释放连接，再调用回调；回调在单连接配置下
  查询 access hash 不死锁。当前读取整个账户频道列表，未做大账户内存测量。
- 真实 Manager 两次新建，中间关闭并重开 SQLite：第一轮提交 PTS=11，
  第二轮从 11 继续处理到 12，两条业务载荷均保留。
- 新增 3 项存储测试和 1 项 Manager 集成测试；全部 Go race 测试及 go vet 通过。

收件事件和检查点仍是两个提交，不因同一数据库而自动具备事务原子性，仍须使用
FailureFence。此批没有崩溃补差、远端重放、频道 gap 或真实账号测试，也未接入
完整启动/重载程序。hash 留存与检查点表容量不受 inbox 载荷配额限制，尚需容量策略。

## 第十九批验证：故障后的补差恢复

使用真实 gotd Manager、SQLite Store 与 FailureFence，将启动补差、载荷持久化、
检查点恢复、TL 解码、消息归一化和命令分发连接为离线集成测试。

- 入队配额不足时停止 Manager，重开数据库后仍从 PTS=10 请求补差。
- 入队成功但 SetState 注入写入错误时，载荷保留且检查点仍为 10；
  重建 Manager 后再次补差，同一合成事件 key 不新增队列记录。
- 恢复后检查点为 11，队列只有一条记录；解码并分发到计数处理器一次，
  标记完成后待处理队列为空。
- 两个场景所在适配包通过 race 重复 20 次；全部 Go race 测试及 go vet 通过。

API 响应与事件 key 均为单消息测试夹具，未连接 Telegram，也未实现生产事件身份
算法或自动恢复协调器。检查点失败为方法级注入，不是断电或磁盘故障。
分发到计数处理器一次不能证明外部副作用恰好执行一次；业务执行后、完成标记前
崩溃的重放仍需要业务幂等策略。频道/QTS/分片补差与完整插件迁移尚未验收。
本批没有系统性能结论，不据此确定最终技术栈，生产代码未改动。

## 第二十批验证：持久队列消费组件

新增 inbox.Consumer，按持久序号顺序处理有限批次，在处理器成功返回后写入完成标记。
处理器错误、panic 或完成确认失败均停止本批，后续事件不会越过失败事件执行；
已成功确认的前序事件保留完成状态。返回已确认数量及带序号的错误，重试由调用方决定。

- 同一 Consumer 实例的重叠调用返回 ErrConsumerBusy，不启动第二批处理。
- 三事件样例在第二条失败，数据库重开后仅重放第二、三条；有限批次和空队列通过验证。
- panic 后实例可再次使用；处理器执行后取消 context 导致确认失败，事件仍待处理。
- 第十九批两个 Manager 补差恢复场景改为通过 Consumer 解码、分发和确认。
- inbox 与 telegramio 的 race 测试重复 20 次通过；全部 Go race 测试及 go vet 通过。

Consumer 不是跨实例或跨进程租约；应用必须为同一数据库维护唯一消费实例。
当前每批加载全部选中载荷，条数限制不等于字节内存限制。没有后台轮询、自动重试、
死信跳过或跨账户公平调度。处理器不响应取消时不能强制终止；外部副作用仍需幂等策略。
这是候选运行时组件，不是已完成的业务插件迁移或全系统性能验收。

## 第二十一批验证：持续消费与代次排空

Consumer.Run 持有实例消费权直到退出：连续处理可用批次，空批次后等待配置的轮询间隔，
context 取消会中断等待。处理或确认错误直接返回调用方，不自动重试或跳过事件。
Run 与 Process 共享实例准入控制，运行期间额外调用被拒绝。

- 新增事件能够触发处理；业务失败退出后，事件保留并可显式重试。
- 将 Run 注册为 Generation 任务，空队列和活跃处理器两种场景均能取消排空；
  活跃处理器收到取消并返回，事件未被确认。空队列测试包含启动取消竞态，
  未精确断言取消发生时已进入 timer 等待。
- 无效批次大小和轮询间隔被拒绝。
- 全部 Go race 测试、go vet 通过；消费者测试在 race 下重复 30 次通过。

本批用实际 SQLite 临时库和合成处理器，没有外部业务调用。轮询间隔由调用方显式
提供，尚未通过空闲 CPU 与投递延迟测量确定生产参数。应用级恢复协调、跨实例唯一
消费者约束和非协作处理器的停机策略仍未完成；没有全系统性能结论。

## 第二十二批验证：gt 候选命令层

plugins/gt 使用注入的 AI Provider 与消息接口，实现翻译命令，不依赖旧 TS 运行时。
gt-fixtures.cjs 用关闭的依赖映射执行实际旧 gt 源码及核心 HTML 转义函数，生成
合成输入的请求参数、编辑内容和回复内容，Go 测试逐项比对。

- 14 个对照场景通过：帮助、段落、中英与回复、空输入、过长输入、UTF-16 表情
  长度边界、缺失提供商、长结果分段、提供商错误、空结果、JS 空白差异及预览截断。
- Provider 错误正文不进入用户输出；取消后返回的结果被抑制，预取消不调用 Provider。
- 通过候选 Dispatcher 展开别名后，读取 normalized Text 并按英文翻译；不修改原
  Envelope，普通入站消息不能进入 primary 翻译入口。
- 新包 3 项顶层测试（对照含 14 个子用例）、完整 Go race 测试及 go vet 通过。

这是关键插件适配成本验证，不是最终语言选择。运行时模块无 Node 依赖，但对照测试
需要 Node/esbuild 与旧仓库源码。实际 AI Provider、Telegram 消息端口、配置迁移和
插件装载尚未连接。停机依赖外层 generation context 取消与任务跟踪，不复用旧插件
实例的 cleanup 方法。未验证全部消息发送故障、畸形 Unicode 或真实服务端限长行为，
不得将本批结果视为 gt 端到端迁移完成。生产代码未改动。

## 第二十三批验证：AI HTTP 传输组件

新增 aihttp.Client，由应用注入 RoundTripper、请求超时和响应体字节上限。
PostJSON 序列化请求、复制头部并设置 JSON 类型；请求 context 覆盖网络操作与响应体读取。
超限返回明确错误，响应体关闭；取消和 deadline 错误供运行时识别。

- 本地 HTTP 服务验证方法、请求 JSON、认证头和原始响应；不修改调用方头部。
- 响应体超限被拒绝；429 仅返回状态码，不返回服务端正文。
- 重定向返回状态错误，没有请求目标路径。
- 服务端先发送响应头再阻塞响应体：配置超时和父 context 取消均能结束读取。
- 4 项测试通过，race 重复 20 次通过；完整 Go race 测试及 go vet 通过。

当前只处理缓冲响应，没有 SSE、重试、Retry-After 或具体 AI 协议解析，尚未接入 gt。
拒绝重定向是候选策略，需对照现有提供商验证兼容性，不代表原系统采用相同策略。
状态码之外的提供商诊断尚未结构化保留。代理/TLS/连接池由应用注入，相关集成未测试；
没有真实模型调用或完整性能结果。生产源码与配置未改动。

## 第二十四批验证：gt 到 Chat Completions 的本地链路

TextChat 接入 aihttp，使用完整 endpoint 和头部快照发送非流式纯文本请求；
支持普通聊天提示词以及独立翻译提示词，后者沿用旧 ai.translateText 文案。
model、reasoning_effort 和 service_tier 来自配置；auto 与空值省略可选参数。

- 本地服务接收到英文翻译请求，返回文本后经 gt HTML 转义输出。
- 翻译不修改普通聊天提示词，调用者后续修改头部不影响已构造的客户端快照。
- JSON 畸形、空 choices、null 和数组形式 content 被明确拒绝；stream=true
  在构造时返回未实现错误，不静默改为非流式。
- 新增 2 项顶层测试（异常响应含 4 子用例）；aihttp race 重复 20 次、
  完整 Go race 测试及 go vet 通过。

查阅官方 Chat Completions 接口并核对旧实现：
<https://developers.openai.com/api/reference/typescript/resources/chat/subresources/completions/methods/create>。
本批使用 fixture-model 和本地 HTTP 服务，未调用任何真实模型。它验证基本传输与
命令组合，不证明第三方提供商兼容。数组 content、流式、Responses、Gemini、
搜索与媒体路径仍需适配，不能删减为纯文本功能。配置读取迁移、UA/auth 策略、
错误细分与真实 Telegram 输出未连接；技术栈和全系统性能结论仍未确定。

## 第二十五批验证：Chat SSE 文本收集

TextChat 支持 stream=true，按 SSE 事件解析 delta.content 并拼接文字；仍由有上限的
HTTP 缓冲操作收集完整响应后输出，不是逐字编辑 Telegram 消息。配置超时覆盖整个读取。

- SSE 注释、事件字段、多行 data、BOM、CR/LF/CRLF、usage 空 choices 通过测试。
- 增量片段的空白保留，整体结果最后 trim；本地服务逐字节写入并 flush，中文和
  表情完整还原，随后经 gt 输出。底层网络可能合并数据，未声称每次客户端 read 为一字节。
- 提供商 error、畸形 JSON、未终止事件、缺失 DONE、完成后追加 data 和空结果均拒绝。
- 新增 3 项测试；aihttp race 重复 20 次、完整 Go race 回归及 go vet 通过。

与旧解析器存在已知差异：旧代码可忽略坏 JSON、接受缺少完成标记的部分结果，
并支持流式请求返回普通 JSON。候选目前严格拒绝这些情况，需要在提供商兼容矩阵中
逐项处理，不能据此宣布全部流式服务兼容。数组 content、媒体、引用和 Responses
事件仍未实现。当前缓冲 SSE 会占用响应体及解析副本内存，需在完整负载中测量；
本批没有真实模型调用、性能收益结论或生产改动。

## 第二十六批验证：文本内容块兼容

文本适配器现在解析字符串、单个 text/output_text 对象及对应数组，数组用换行拼接
并沿用旧版 trim 行为。普通响应和 SSE delta 共用此解析器，普通 Chat 输出整体 trim
与旧 aggregateOpenAIResponses 对齐。

- 测试工具通过 TypeScript AST 提取具名变量声明，执行实际旧文本解析、来源收集和
  聚合函数，不初始化旧 AI 插件或访问配置。7 组字符串/对象/数组/Unicode 样例的
  普通文本与单事件 SSE 结果和旧聚合器一致。
- 混合图片块、未知块与非内容值返回 ErrUnsupportedContent，不部分返回文字。
- 完整 Go race 测试及 go vet 通过；评估目录 Node 测试 38/38 通过。

媒体返回类型和渲染仍未连接，报错是明确未完成状态而非功能替代。旧解析器接受的
更多 fallback 字段、空结果占位文案与未知块容错尚未逐项等价；本批不能证明全部
提供商响应兼容，也未进行在线调用。source-harness 的变量抽取仅服务离线对照测试。

## 第二十七批验证：旧 AI 配置文档

aiconfig.Document 从调用方提供的字节读取旧 JSON，不访问默认配置目录。
保留原始字节及各字段 RawMessage，读取当前聊天选择时返回独立快照。
WithChatModel 生成新的旧格式文档，仅修改 currentChatModel，不注入默认值或推断提供商。

- 合成配置覆盖多模式字段、提供商未知嵌套数据、Telegraph 记录、NULL、
  9007199254740993 与高精度小数；未编辑时字节完全一致。
- 模型更新再恢复后，比对所有字段的压缩 JSON 值一致；未知数据和数字原值保留，
  原文档不改变。编辑会改变顶层键顺序和空白，不保证编辑后文件字节一致。
- 非对象、畸形 JSON、顶层重复键和无效聊天选择被拒绝，错误不含凭据内容。
- 3 项测试、完整 Go race 回归和 go vet 通过。

这不是完整配置迁移器：提供商 profile/endpoint/auth/defaults 尚未映射到运行时，
timeout 保留原值，未改变单位或应用到 HTTP 客户端。模块没有文件写入；磁盘原子保存、
权限、并发修改检测、跨版本切换与切换后新增业务数据回退仍待实现。测试仅读取合成字节，
没有打开生产 assets 或执行模型请求。

## 第二十八批验证：旧配置到聊天 Provider

Document.BuildChat 将明确 type=openai/openai-compatible 的旧配置映射到 TextChat，
复制原 User-Agent、Bearer 认证、聊天模型和提示词，规范化 reasoning/service tier；
timeout 从秒转换为 duration，缺省为旧版的 30 秒。配置文档不发生写入或修改。

- 合成配置经 BuildChat -> gt -> 本地 HTTP 完成翻译，核对 /v1/chat/completions、
  Bearer、UA、模型、reasoning 与无效 tier 归一化后的省略行为。
- 0.03 秒配置能在响应体阻塞时触发 deadline，验证单位转换。
- 缺失/未知/未实现 profile、Responses 模式和负超时被明确拒绝，不改用其他协议。
- 新增 2 项测试；完整 Go race 回归、go vet 通过，配置包 race 重复 20 次通过。

当前只验证常规基础 URL；原系统的提供商自动识别、各 profile endpoint、Responses、
Gemini 及特殊 URL 仍需完整对照，不能将拒绝这些配置视为功能迁移完成。URL 中的
userinfo 被拒绝，是候选策略，尚未验证历史配置兼容。认证头不写入诊断；测试只用
synthetic key 和本地服务，未读取用户配置或调用真实模型。尚无磁盘保存和部署切换。

## 第二十九批验证：旧提供商自动识别

ProviderProfile 沿用旧版显式类型优先、主机映射其次、默认 openai 的顺序，
并连接 Document.BuildChat。未知类型字符串按旧行为进入自动识别，不写回配置。

- 执行实际旧 resolveProviderType 及依赖声明生成 17 个样例，覆盖全部主机映射、
  自定义域名、localhost/IPv6、大小写、尾点、显式覆盖、未知类型、Unicode 空白、
  无效与无协议地址。候选分类结果全部一致。
- 自动识别为 openai 的配置可构造 Provider；识别为未实现协议的配置明确拒绝。
  构造测试不发送网络请求，且原配置字节不变。
- 新增 2 项顶层测试；完整 Go race 回归和 go vet 通过。

这验证的是提供商身份，不是全部协议支持。Go net/url 与 JavaScript WHATWG URL 的
全部规范化规则尚未证明等价，特殊数字 IP、反斜杠、编码主机名及 URL 周围空白等仍需
对照；常规样例通过不能推出任意历史地址兼容。Responses 与其他提供商、媒体、完整
配置迁移和同功能性能验收仍未完成，生产未改动。

## 第三十批验证：更多 Chat Completions 配置

BuildChat 接入 moonshot、doubao 与 local-cliproxy 的文本聊天路径。Moonshot 使用
原始基础地址和 Bearer；豆包使用 origin + api/v3/chat/completions；本地代理规范化
OpenAI 基础路径并使用查询参数 key。沿用原配置中的 stream 和聊天参数。

- 9 组地址/认证样例执行旧 resolveBaseUrl、resolveEndpointUrl、normalizeOpenAIBaseUrl
  和 applyAuthConfig 比对，通过常规路径、query、编码路径与 Cloudflare 网关场景。
  测试的 profile mode 表按当前旧源码填写，不是自动解析整个 profile 注册表。
- 三种 profile 均通过本地 HTTP 翻译测试，检查请求路径、Bearer 或 query key。
- 新增 2 项顶层测试（本地请求含 3 子用例）；完整 Go race 回归和 go vet 通过。

仅迁移这些 profile 的文本聊天入口；豆包图片输入策略、搜索、图片和视频模式并未完成。
真实服务商、所有 URL 规范化细节、Responses 和 Gemini 仍需验证或实现。查询参数密钥
由旧协议要求产生，候选传输错误不包含请求 URL，但未来访问日志仍须做脱敏。
本批没有联网模型调用、数据写入、部署或系统性能结论。

## 第三十一批验证：gt Telegram 消息端口

GTMessage 使用固定 gotd v0.161.0 的 message.Sender 和 HTML 实体构建器，
实现 gt.Message：读取被回复消息、编辑命令消息、回复分段结果。
频道读消息使用 ChannelsGetMessages 和已解析 access hash；其他已支持 peer 使用
MessagesGetMessages。发送和编辑沿用 gotd RPC 构造，不手写 HTML 实体偏移。

- 合成 RPC 经 TL 编码/解码检查目标、消息 ID、reply ID、非零 random ID、
  HTML 转义及表情前缀后的 UTF-16 bold 偏移。
- 频道回复查询 -> gt 翻译 -> 编辑与续段回复通过；无回复不请求历史，预取消不发 RPC。
- 合成 NewMessage -> NormalizeUpdate -> Dispatcher -> 旧配置构造的 AI Provider ->
  本地 HTTP -> GTMessage 编辑 RPC 的组合测试通过。
- 新增 4 项测试；完整 Go race 回归、go vet 通过，telegramio race 重复 20 次通过。

仅使用合成 Invoker 与本地 HTTP。调用方必须提供已授权且解析正确的 peer/hash；
InputPeerFromMessage 类型、跨对话回复和真实论坛话题行为仍待适配/验证。端口没有
业务级重放幂等记录，Sender 自动生成 random ID 不等于跨重启恰好发送一次；RPC 返回
Updates 尚未接入更新协调器。该集成不是已登录 Telegram 的完整运行程序，不构成
全系统迁移或性能结论。生产代码未改动。

## 第三十二批验证：持久 peer 解析

ResolvePeer 从调用方确认的账号 ID 和 PeerHashes 读取目标：本人使用 InputPeerSelf，
普通群组使用 ChatID，用户/频道按账号与类型读取完整 access hash。缺失用户 hash
（含零值）明确报错，数据库错误不伪装成缓存未命中。

- SQLite 关闭重开后解析用户/频道，验证相同大整数 ID 的不同类型 hash 不混淆；
  不同账号不能读取该记录，负 access hash 和 9007199254740993 保持精确。
- 本人/普通群组不查询 hash；缺失、无效 peer、预取消和关闭数据库错误通过测试。
- 翻译组合测试改为从缓存解析目标后构造 GTMessage，不再直接传入测试 InputPeer。
- 新增 2 项测试；完整 Go race 回归、go vet 通过，telegramio race 重复 20 次通过。

当前仅消费可信的完整 hash；固定 gotd feeder 跳过 min 用户/频道的行为已读源码核对，
但没有由真实更新填充缓存的在线验证。缓存过期/缺失的网络补全、FromMessage peer、
用户名/链接解析及 hash 写失败恢复仍待实现。调用方必须独立完成账号验证和命令授权；
缓存命中不赋予业务权限。没有生产访问、部署或全系统性能结论。

## 第三十三批验证：hash 写入与检查点故障边界

HashStorage 将用户/频道 access hash 写入纳入与入队、检查点相同的 FailureFence，
读取继续转发。已有持久 Manager 与补差恢复测试统一使用该包装。

- 真实 gotd Manager 的离线对照复现：不包装 hash 存储时，注入用户或频道 hash
  写入失败，仍会入队并将 PTS 从 10 推进到 11；这是库 feeder 记录错误后继续执行的结果。
- 包装后，同样故障触发 Manager context 取消；持久 PTS 保持 10，失败更新不进入
  业务队列。已失败的 fence 拒绝后续用户/频道 hash 写入。
- 成功路径验证频道 hash=303 保存且 PTS=11、队列一条，证明保护不是一律阻断写入。
- 新增 2 项顶层测试（Manager 对照含 6 场景）；完整 Go race 回归、go vet 及
  telegramio race 重复 20 次通过。

故障为存储方法级注入，不是实际磁盘故障或线上事件。hash 与业务事件依旧分开提交，
保护不能代替完整事务、恢复协调或所有更新路径审计。当前 Manager 配置仍需显式使用
同一 fence；完整启动装配尚未完成。生产系统不受本批更改影响，未产生性能结论。

## 已查证的一手资料

查阅日期：2026-09-05。web 工具未返回内容，使用 HTTPS 直接读取官方源仓库。
滚动分支仅作初筛依据；可执行探针必须固定发布版本及锁文件。

- gotd：`https://raw.githubusercontent.com/gotd/td/main/README.md`
  描述原始 MTProto、用户登录、context 取消、上传下载及可替换 Session 存储。
- gotd 发布元数据：`https://proxy.golang.org/github.com/gotd/td/@latest`
  本次返回 v0.161.0，2026-07-14，提交 d642c299fe122f4cf60bd91f0a88026587cd9300。
- gotd Session：`https://raw.githubusercontent.com/gotd/td/v0.161.0/session/session.go`
  Data 包含 Config/DC/Addr/AuthKey/AuthKeyID/Salt，Loader 使用版本化 JSON。
- Telethon：GitHub README 指向 Codeberg 新上游；
  `https://codeberg.org/Lonami/Telethon/raw/branch/v1/telethon/sessions/string.py`
  使用 IP packed bytes 和 URL-safe base64，区别于本地 Teleproto 地址字符串格式。
  PyPI 元数据 `https://pypi.org/pypi/Telethon/json` 本次返回 1.44.0；
  已安装该版本并检查其运行时 layer=227。
- grammers：`https://raw.githubusercontent.com/Lonami/grammers/master/README.md`
  指向 Codeberg 新上游；继续读取
  `https://codeberg.org/Lonami/grammers/raw/branch/master/grammers-client/Cargo.toml`
  得到开发分支包版本 0.10.0、edition 2024。开发分支版本不等于最新已发布版本。
- TDLib：`https://raw.githubusercontent.com/tdlib/td/master/README.md`
  说明 C/JSON 接口、C++17/OpenSSL/zlib/gperf/CMake 构建依赖及 API 版本兼容边界。
- grammers 发布元数据：`https://crates.io/api/v1/crates/grammers-client` 确认 0.10.0 已发布，
  时间 2026-07-02，未撤回；预发布依赖信息见 `https://crates.io/api/v1/crates/glass_pumpkin`。
- TDLib 固定版接口：`https://github.com/tdlib/td/blob/d1085f9cebc5a62379991ae1652673954f229c1f/td/telegram/td_json_client.h`
  和同提交 `td/generate/scheme/td_api.tl`；已读取下载后的实际源码。
- Rust 发布清单：`https://static.rust-lang.org/dist/channel-rust-stable.toml`，本次返回 2026-09-03 的 1.98.1。
- SQLite 只读 WAL 条件：`https://www.sqlite.org/wal.html#read_only_databases`。
- Python SOCKS 发布元数据：`https://pypi.org/pypi/python-socks/json`，本次返回 3.0.0，
  Python >=3.9；同时核对已安装 Telethon `network/connection/connection.py` 并完成本地握手验证。
- robfig/cron 发布版文档：<https://pkg.go.dev/github.com/robfig/cron/v3@v3.0.1>，
  本批 web 可访问；同时检查模块缓存中的 parser.go/spec.go，并以实际 Node/Go 日期结果对照。
- go-sqlite3：<https://github.com/mattn/go-sqlite3>，同时检查 v1.14.52 模块 README；
  `go list -m -json` 返回该版本发布时间 2026-09-05T04:18:43Z，实际 CGO 构建和数据库测试通过。
