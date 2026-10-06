# @240xu/dsh-seqguard

DSH web 插件：会话 seq 完整性守卫（检测 + 受控自动修复）。

## 防的是什么

[deepseek-harness discussion #8984](https://github.com/deepseek-ai/deepseek-harness/discussions/8984)：
Termux/bionic 没有 flock 绑定，会话写锁降级为 `posix-unlocked`（空租约）。当 seed/构造句柄与
stale resume 句柄同时写同一个会话文件时，会写出**重复 seq**，而 dsh 的严格校验器在读取时
会**整份拒收**（"invalid committed event ... has seq gap"）→ 历史全部打不开。

实测的损坏形态高度规整：首个重复行起，所有行的 `seq` 相对行号恒定偏移 **-1**（缺一个号）。
因此修复是良定义的：**重复行及其后所有行 seq +1，帧边界与帧 0 header 逐字节保留**。

## 行为（保守性是设计的一部分）

- 定期扫描 `~/.dsh/sessions` 下全部 `session[.vN].jsonl.zstd`；mtime 在 `idleGraceMs`
  内的文件跳过（正在写）。未变更文件（mtime+size 相同）走缓存，稳态近零开销。
- 只修复**单一位移**这一类；以下情况**只报告、绝不写盘**：
  - 撕裂尾（Node 的 zstd 对截断输入是宽容的——靠"帧文本必须以 `\n` 结尾"结构性识别）；
  - 两个独立缺口（位移漂移）；
  - 任何未知形状（无 seq 行、不可解析行、非首帧解压失败）。
- 自动修复前过三重门：**双次 stat 稳定** → **/proc 无 fd 持有** → **重读仍可修**；
  落盘前先备份 `.bak-seqguard-<ts>`，再 temp + rename（本文件系统上原子），写后重新
  分析**实际写入的字节**必须为 clean 才算完成。
- 首扫全量，之后只重读变更过的文件。

## 第二类损坏：v4 message source（已纳入 0.2.0）

校验器 `dsh-session-format-v3-to-v4` 要求**声明过的持久消息槽**里每条消息都带
producer-owned 的 `source`（对象、`kind` 非空字符串、且不能是旧版 `plugin` 包装器）。
v3 迁移上来的行带着 `{kind:"plugin", plugin:"<pkg>"}`，或缺 `source`，就会让整份拒读：
`format v4 message requires a producer-owned source kind`。

修复分两档（按"修法有多确定"划分）：

| 情形 | 处理 |
|---|---|
| `kind:"plugin"` 且 `plugin` 是字符串 | **确定性改写**：照上游 `producerKind` 映射表（改名表/同名表/其余 `plugin:<name>`）改 kind 并删除 `plugin` 字段。配置 `repairSourceKind: true` 开启自动写 |
| `system/message`（role=system）缺 source | **推断补全**为 `{kind:"system-prompt"}`（健康同类会话就是这个形状）。配置 `inferSystemSource: true` 开启 |
| 其它缺失/非法（`user/message` 无 source 无 role 等） | **只报告，绝不写**——不猜归因 |
| `assistant/message` 无 source | **不算问题**：原生 v4 的 assistant 消息本来就没有 source（已对健康会话核实） |

实测（365 个会话文件）：317 干净 / 27 个确定性可修 / 21 个需判断（96 行，其中
47 行 system/message 缺 source 属可推断类）。

## 端点（loopback / same-origin 信任门，同 lazy-view）

| 端点 | 说明 |
|---|---|
| `GET /seqguard/status` | 上次扫描时间、统计、修复/拒收报告 |
| `GET /seqguard/check?path=<project>/session-<id>/session.v4.jsonl.zstd` | 只读分析单个文件 |
| `GET /seqguard/repair?path=...` | 手动修复（同样过三重门与备份） |

## 配置（cordis.patch.yml insert 块 config）

```yaml
config:
  autoRepair: true          # seq 类：自动修（关掉则只报告不写）
  intervalMinutes: 30       # 扫描周期
  idleGraceMs: 180000       # 跳过最近 3 分钟内被写的文件
  repairSourceKind: false   # v4 source：确定性 plugin-wrapper 改写（默认关）
  inferSystemSource: false  # v4 source：system/message 缺 source 推断为 system-prompt（默认关）
```

## 安装

```sh
# 方式 A（推荐）：DSH 官方插件命令
dsh plugin --profile web add @240xu/dsh-seqguard

# 方式 B：npm pack 直解（profile 是 pnpm workspace，勿直接 npm i）
cd ~/.dsh/profiles/web/node_modules
npm pack @240xu/dsh-seqguard
mkdir -p @240xu/dsh-seqguard
tar -xzf 240xu-dsh-seqguard-*.tgz -C @240xu/dsh-seqguard --strip-components=1
# 然后把 "@240xu/dsh-seqguard" 加进 profile package.json 的
# dependencies + dsh.profile.bundles（两处都要，否则 reconcile 会摘掉）
```

## 自检

```sh
node lib/selftest.js   # 合成夹具：检测/修复/拒绝/撕裂/干净 五类路径，全绿 exit 0
```

## 已知限制

- 只修"单一位移重复 seq"这一类；其它损坏只报告。
- 撕裂尾判据是"帧末尾无换行"——若崩溃恰好截在行边界（概率 ~1/行宽），会被判 clean；
  这与 dsh 自身把该帧视作完整提交的行为一致，无额外风险。
- 修复时若文件正被活跃写入（fd 门/稳定门漏网的极窄窗口），宁可 busy 放弃也不写。
