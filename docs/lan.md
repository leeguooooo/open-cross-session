# 局域网 ocs（v0.6.0 起）

同一局域网里的两台机器配对之后，一台上的 agent 可以 `ocs dm <地址>@<对端> "…"` 给另一台上的
Claude / Codex / Pi 会话发消息并唤醒它，`ocs who --lan` 列出对端可达的 agent。
默认关闭，`ocs lan up` 才开。

```bash
# machine A (e.g. mini)
ocs lan up
ocs lan pair                 # prints a text to send to B, waits for B's request

# machine B (e.g. laptop) — the lines from A's text
ocs lan up
ocs lan join k3m9q2xa7bfw4ndcuy2e --addr 192.168.1.20:47890
                             # shows a 6-digit check code; A sees the same code and answers y
ocs who --lan                # A 上的 agent：claude-1a2b3c4d@mini …
ocs dm claude-1a2b3c4d@mini "帮我看下 CI"
```

A 那边被唤醒的会话看到发送者是 `claude-9f8e7d6c@laptop`，`Reply:` 行是
`ocs dm claude-9f8e7d6c@laptop "<your reply>"`，复制执行就回到 B。

范围：只有跨机 DM 和远端花名册。频道不跨机复制；两台机器各有自己的频道日志和 seq
（铁律 1 不变）。不同网络的机器走虚拟局域网，见下文「不同网络」；跨机共享的多方频道不做（AgentParty 已停止维护，不再引导过去）。

## 威胁模型

对端能做的事：列出本机可达会话（地址、种类、忙闲、一句短标签；没有 pid、路径、cwd），
给其中任何一个发 DM 并唤醒它。这等于本机另一个会话能做的事，所以**配对就是授权**，
要当成「允许这台机器给我的 agent 下提示」来对待。消息正文进入对方 agent 的上下文时仍然
包在跨会话标签里、标明来源 `x@peer`，是数据不是指令；Claude 侧的 `crossSessionInbound`
闸照常生效。

防的是同一局域网里的其他人（咖啡馆 Wi-Fi、公司网、被攻破的 IoT 设备）：

| 攻击 | 挡法 |
|---|---|
| 未配对机器连上来发消息、看花名册 | 握手后按公钥查信任库；未配对只能兑现一份开着的配对码，其它请求一律 `unpaired` |
| 冒充已配对的对端 | 身份 = Ed25519 公钥；客户端钉死完整指纹，服务端按公钥查信任库；IP / 名字只是提示 |
| 中间人 | 服务端签名覆盖双方临时公钥；客户端签名再覆盖双方长期公钥；换任何一把钥匙签名都验不过 |
| 窃听 | 每连接临时 X25519 + HKDF → AES-256-GCM；前向保密 |
| 篡改 / 重放 / 删帧 / 调序 / 反射 | GCM 隐式计数器（不上线）、按方向分钥、方向写进 AAD |
| 截获配对码后抢先兑现、或冒名发码方 | 码里含发码方公钥指纹前 64 位，客户端先核对再发令牌；令牌一次性、10 分钟过期 |
| 猜配对码 | 56 位令牌只能在线猜；所有开着的邀请累计 5 次错码即作废 |
| Impostor answers a `join` (0.8+) | The pairing text carries 100 bits of the inviter's fingerprint; the requester pins it in the handshake and sends neither its identity nor the request on mismatch |
| Stranger slips in a pairing request (0.8+) | Requests are only accepted while `ocs lan pair` is waiting, one at a time; the inviter's human must see the same 6-digit check code (derived from that connection's transcript and session key) as the requester before trusting it |
| Stranger pops prompts on an idle machine (0.8+) | No open invitation → immediate `no-offer`; request rate shares the 10/min/IP pairing limit |
| Trust outlives its purpose (0.8+) | Pairing grants 8 h by default (`--once`, `--for`, `--forever`); expired or used-up peers are unpaired at the handshake and pruned on the next trust-store write |
| 远端冒充本机会话名 | 发送者一律显示 `<对方地址>@<本机给对端起的 label>`，label 远端改不了 |
| 正文闭合包装标签、伪造 `Reply:` 行 | 唤醒 note 里正文的 `<cross-session-message` 被中和成 `‹…`，行首形似 `Reply:` / `Thread:` / 唤醒首行的加 `> `（wake-protocol §1）；Codex queue / Pi / cmux 这类没有包装的载体同样生效 |
| 远端随手造频道塞满磁盘 | 远端 DM 只投活目标（Claude 活会话或登记过的 ocs 名字；Codex 要有活进程持有 rollout；Pi 要有活登记；Hermes 要宿主此刻列为打开），其余 `not-found` 不落盘；每对端限速 30 条突发、0.5 条/秒，且每 UTC 日正文 ≤16 MiB |
| 资源耗尽 | 握手帧 ≤1 KiB（未配对全程 ≤1 KiB），已配对 ≤1 MiB，大小在分配前检查；一问一答之外多出来的帧（流水线灌帧）立即断开；并发 64，其中未认证（含握完手但未配对的）每 IP 8、全局 32，一直占名额直到断开；握手 5 秒、未配对请求 5 秒超时 |
| 对端往本机终端塞转义序列 | 远端返回的每个字符串都校验或清洗：地址必须过 `NAME_RE`，错误码限 `[a-z-]`，其余文本剥控制字符、限长；对端自报名进信任库前收成 label 字符集 |
| 远端 DM 顺带打探本机 | 应答里不带歧义候选（含 pid / cwd）、不带原始错误信息，投递行里的 pid 抹掉 |
| 发现被用来放大流量 | 查询必须补齐到 ≥256 字节，应答恒比查询小；每源 10 秒 10 次，限速表满时新来源不应答（不清表）；查询方最多收 32 条应答、按指纹筛后最多试 4 个地址 |
| 本机其他用户改信任库 / 读私钥 | `$OCS_HOME/lan` 0700、文件 0600；加载时发现非本人、符号链接、组/其他可访问即拒绝（ssh 式） |
| 守护进程把启动它的会话当成自己 | 启动时剥掉 `CLAUDE_CODE_*` / `CODEX_THREAD_ID` / `OCS_NAME` / `OCS_PI_SESSION_ID` |

不防：同一局域网的人可以连猜 5 次错码把**当前开着的**配对码作废（只是拒绝服务，猜不中；
重新出码即可，`ocs lan pair` 会明说码被作废了）。已配对机器本身被攻破（它本来就被授权了；`ocs lan unpair` 撤销）、本机 root、
流量分析（能看到两台机器在通信、大致多大）。

## 协议 `ocs-lan/1`

TCP，默认端口 47890。帧 = 4 字节大端长度 + 载荷。**一请求一连接**，没有长连接状态。

```
C → S  hello      {t, proto, eph_c, nonce_c}                    明文 JSON
S → C  hello-ack  {t, proto, eph_s, nonce_s, key_s, sig_s}      明文 JSON
C → S  auth       {t, key_c, sig_c, port}                       AEAD c2s #0
S → C  welcome    {t, paired, name}                             AEAD s2c #0（密钥确认）
C → S  请求 {op, …}                                             AEAD c2s #1
S → C  应答 {ok, …}                                             AEAD s2c #1
```

- `eph_*`：X25519 临时公钥 32B；`nonce_*` 16B；`key_*`：Ed25519 长期公钥 32B；全部标准 base64，
  长度不对即断。
- `th = SHA-256("ocs-lan/1\0transcript\0" ‖ eph_c ‖ nonce_c ‖ eph_s ‖ nonce_s ‖ key_s)`（定长拼接）。
- `sig_s = Ed25519(key_s, "ocs-lan/1\0server\0" ‖ th)`；
  `sig_c = Ed25519(key_c, "ocs-lan/1\0client\0" ‖ th ‖ key_s ‖ key_c)`。
- `c2s ‖ s2c = HKDF-SHA256(ikm = X25519(eph), salt = th, info = "ocs-lan/1\0keys", 64)`；
  共享秘密全零（小阶点）即拒。
- AEAD = AES-256-GCM（Bun 没有 ChaCha20-Poly1305），IV = 4 字节 0 ‖ 8 字节大端计数器，
  每方向从 0 起、每帧 +1、不上线；AAD = `"ocs-lan/1\0c2s"` / `"ocs-lan/1\0s2c"`。
- 客户端收到 `hello-ack` 验签后**先核对 `key_s`**（已配对：完整指纹；配对中：配对码里的前缀），
  不符就断开，本机身份和请求都不发出。
- 指纹 = base32(SHA-256(key))，52 字符，小写 RFC 4648 字母表。

请求：

| op | 谁能发 | 请求 | 应答 |
|---|---|---|---|
| `ping` | 已配对 | — | `{ok, name}` |
| `who` | 已配对 | — | `{ok, name, entries:[{address, kind, status?, label?}]}` |
| `dm` | 已配对 | `{from, from_key, to, body, lang}` | `{ok, channel, seq, to_key, to_display, outcome, lines}` 或 `{ok:false, error}` |
| `pair` | 任何人 | `{token, name}` | `{ok, name, expires_at?, uses?}` 或 `{ok:false, error}` |
| `pair-request` (0.8+) | anyone, only while an approve invitation is open | `{name}` | after the human decides (≤75 s): `{ok, name, expires_at?, uses?}` or `{ok:false, error}` with `no-offer` / `busy` / `rejected` / `timeout` / `cancelled` |

`from` 是对方回复用的地址（ocs 名字优先，否则短 id），`from_key` 是不随改名变的短 id。
`outcome` 是远端唤醒阶梯的总体结果（`ok` / `failed` / `unknown`），映射到发送方退出码 0 / 2 / 3，
语义同本机 DM：落盘了就别重发。目标是 Claude 会话时守护进程走带回执的唤醒（wake-protocol §6）：
第一阶段结果在 `lines` 里（`accepted` / `HELD` / `NOT delivered: refused` …），被扣或被拒归入
`outcome: "failed"`——线上格式没变，0.6 的发送方照样读得懂。被扣消息的终态（批准 / 过期）只记在
**接收端**的频道日志里，不回传、不通知发送方：那需要接收端主动连回发送方再发一条请求，等于新增一个
「对端可以主动唤醒我」的 op，和「请求发出后没应答绝不重发」的规则叠在一起并不简单，没有做。请求发出后没收到应答同样按 `unknown`（退出码 3）处理，
**绝不自动重发**（铁律 5）。

### 频道与身份

两端各自落盘，频道名按同一规则派生，所以一来一回落在同一个频道：

```
lan-<SHA-256(对端指纹 ‖ 0 ‖ 本机参与者短 id ‖ 0 ‖ 远端参与者短 id) 前 32 hex>
```

接收方写 `from = <对方地址>.<label>`（`@` 不在 `NAME_RE` 里，旧二进制会拒读），route 旁车帧写
`from_identity = lan:<对端指纹>:<对方短 id>`、`to_identity = <本机目标身份>`，`ocs inbox`
据此认领；发送方在远端确认落盘**之后**写本机副本（`to_identity = lan:<对端指纹>:<目标短 id>`）。

## 配对

发码方 `ocs lan pair`（守护进程要在跑）写一份邀请到 `$OCS_HOME/lan/offers/`（只存令牌摘要），
打印配对码并阻塞等待，成功、过期、作废、Ctrl+C、关终端（SIGHUP）都会删掉邀请。兑码时「写信任库 + 标记已配对」
和发码方「关闭邀请」在同一把锁里互斥，不会出现对方已被信任、发码方却报取消的情况。配对码 =
Crockford base32(指纹摘要前 8 字节 ‖ 7 字节随机令牌)，24 字符分 6 组，容忍小写和 I/L/O 混淆。

兑码方 `ocs lan pair <码>`：局域网发现（或 `--addr`）找候选地址 → 握手核对指纹前缀 →
发 `pair{token}` → 双方把对方公钥写进信任库。前缀 64 位决定了冒名发码方要在 10 分钟内找到
一把 SHA-256 前 64 位相同的 Ed25519 钥匙；令牌只在已认证发码方的加密通道里发出，被动窃听拿不到。

`--label` 设本机给对端起的名字（`x@<label>` 里那段），缺省用对方自报的实例名，重名自动加 `-2`。

## Pairing by request (0.8+)

`ocs lan pair` (daemon running) opens an *approve* invitation and prints a block meant to be
copied into a chat: install lines, `ocs lan up`, and `ocs lan join <key> --addr <ip:port>,…`.
`<key>` is the first 20 base32 characters (100 bits) of the inviter's fingerprint; `--addr` lists
the inviter's non-link-local IPv4 addresses, and the joiner falls back to discovery filtered by
the same prefix.

`ocs lan join` connects with the prefix pinned (`peer-key-mismatch` → nothing sent), prints the
6-digit check code and sends `pair-request`. Both ends compute the code independently:

```
sas = u32be(SHA-256("ocs-lan/1\0sas\0" ‖ th ‖ c2s ‖ key_s ‖ key_c)[0..4]) mod 10^6
```

The daemon attaches the request to the open invitation (`$OCS_HOME/lan/offers/<id>.json`,
`request` field; a second one gets `busy`) and polls for a `decision`. The waiting `ocs lan pair`
shows requester name, address, short fingerprint and code, and asks `[y/N]` on a TTY; without a
TTY it prints `ocs lan approve <code>` / `ocs lan reject`, and `approve` only matches a request
with exactly that code. On approval the daemon writes the trust store and marks the invitation
paired under the offers lock (same as code redemption); refusal or the 75 s timeout detaches
the request and leaves the invitation open. The joiner trusts the inviter only after an `ok`
reply, for the period in that reply.

Code invitations (`ocs lan pair --code`) still work and are what 0.6/0.7 peers understand. The
two kinds do not cross: tokens never redeem an approve invitation, and requests never attach to
a code invitation. A 0.7 daemon answers `pair-request` with `unpaired`; the joiner reports that
as `old-peer`.

## Trust periods (0.8+)

`peers.json` entries may carry `expires_at` (ISO time) and `uses_left` (DMs still accepted).
Absent means permanent, which is what every pre-0.8 entry is. The inviter picks the period —
default 8 h, `--for 30m|8h|7d`, `--once` (1 DM, combinable with `--for`), `--forever` — and
returns it in the pairing reply so the joiner trusts it back for the same period.

- An inactive peer (expired, or `uses_left` 0) is `paired:false` at the handshake, so `who` and
  `dm` get `unpaired`; locally, `ocs dm x@peer` refuses before connecting.
- A use is taken only right before a DM is stored for a live target (atomic, under the peers
  lock), so a mistyped address does not burn a `--once` grant. The DM taking the last use goes
  through.
- Every trust-store write drops inactive entries; `ocs lan peers` prunes and reports them.
- `ocs lan trust <peer> --once | --for <d> | --forever` rewrites this machine's period only.

## 发现

UDP 组播 `239.255.67.83:47891`（不用 mDNS，不和系统 mDNSResponder / avahi 抢 5353）。
查询 `{"ocs":"lan-query","v":1,"n":<nonce>,"pad":"000…"}`（用 `pad` 补齐到 ≥256 字节，更短的查询不应答），应答单播 `{"ocs":"lan-here","v":1,"n","name","port","fp"}`。
应答不认证，只当地址提示；只含实例名、端口、公钥指纹。每个源地址 10 秒最多应答 10 次，
应答恒比查询小，没有放大。`ocs lan up --no-discover` 关掉应答，只能靠 `--addr` 配对、靠已知地址互联；
守护进程只听回环（`--bind 127.0.0.1`）时发现也只在回环上。

查询同时发往组播组和每张网卡的子网定向广播（`192.168.1.255` 这类，/31、/32 的点对点网卡跳过）。
2026-09-29 真机实测：家用路由器 + 两端都开着 sing-box tun 时组播到不了，定向广播可以。

组播被屏蔽（访客网络的客户端隔离很常见）时：配对用 `--addr`，之后信任库记住地址，DHCP 换地址时
再靠发现按指纹找回。

## 不同网络（虚拟局域网）

协议只要求两端能互连 TCP 端口（默认 47890），不关心底下是不是物理局域网。不同网络的机器接入同一个
虚拟局域网（Tailscale、WireGuard、ZeroTier 或公司 VPN）即可，ocs 不需要任何改动：

- 守护进程默认监听 `0.0.0.0`，VPN 网卡上的地址也在里面；只想让 VPN 访问时可以 `ocs lan up --bind <本机VPN地址>`。
- VPN 一般不转发组播和定向广播，发现找不到对方：配对用 `ocs lan pair <码> --addr <对方VPN地址>:47890`。
  信任库记住地址，之后重连不需要发现。VPN 地址通常固定，不存在 DHCP 换地址的问题。
- 安全不变量与局域网完全相同：身份只认 Ed25519 公钥，VPN 地址和 label 都只是提示。
- 别把 47890 直接映射到公网。协议是认证加密的，但未配对连接仍能触发握手与配对兑现，没必要把这个面暴露出去。

验证情况：跨网段（`192.168.0.x` ↔ `192.168.1.x`）只靠 `--addr`、不靠组播的配对与互发已在 macOS ↔ Windows
真机上跑通；Tailscale / WireGuard 本身尚未真机验证。

## Windows

2026-09-29 真机验证：Win11 + Claude 2.1.284 ↔ macOS。

- Claude 的收件箱是命名管道 `\\.\pipe\LOCAL\cc-msg-<hex>`。`LOCAL\` 只对**同一登录会话**可见，
  所以守护进程必须跑在 Claude 所在用户的桌面会话里。经 SSH 以别的账号起的进程连不上。
  远程操作时用交互式计划任务，Principal 指定那个桌面用户（`-LogonType Interactive`）。
- 写管道强制带 peer token，token 文件名是**小写**管道路径的 sha256。
- 自身识别：管道名里没有 pid，按 `CLAUDE_CODE_SESSION_ID` + `CLAUDE_CODE_MESSAGING_SOCKET`
  在会话目录里找唯一匹配。Windows 没有 `ps`，祖先链兜底不可用。
- 文件权限靠 NTFS ACL（用户目录默认私有），不检查 mode 位。
- Pi 的收件箱（0.7.2 起）：Windows 上 Node 不能在文件路径上 listen（`.sock` 报 EACCES），扩展改为监听
  `\\.\pipe\ocs-pi-<会话 hash>-<pid>-<128 位随机>`。名字猜不到，别人抢不了先；libuv 独占建第一个实例，
  默认管道 DACL 不让别的账号加实例；每帧仍校验运行期 token。读注册时只认这个形状、且 pid 与注册一致。
  装了旧扩展的 Pi 要 `ocs skill install` 后重开会话。
- 后台进程（守护进程、idle watcher、版本检查）派出前清掉本进程 std 句柄的继承标志（0.7.2 起）：libuv 在
  Windows 上总是带着可继承句柄建子进程，`ocs lan up *> out.txt` 曾让守护进程一直占着 out.txt（#38）。
- 防火墙：给 `ocs.exe` 放行入站 TCP 47890、UDP 47891。家里 Wi-Fi 常被识别成「公用」网络，
  这时规则要带上 Public，并用 `-RemoteAddress <本网段>` 收窄范围，不要整体改网络类型。
- `crossSessionInbound` 默认 hold：远端消息进收件箱后 5 分钟没人点投递就被丢弃。Windows 上没有投递回执
  （回执地址得是命名管道并带认证材料），发送方看到的仍是「已投递收件箱」；macOS / Linux 接收端会如实报
  「被扣留」。要让 agent 之间自动往来，设 `"crossSessionInbound": "accept"`（`ocs doctor --fix`）；
  代价是已配对机器发来的消息不经人确认就进入 agent。

## macOS 防火墙

应用防火墙开着时，没登记过的程序收不到局域网连接，而且**不报错**：对端只看到「连不上」，本机日志里一行都没有。
放行规则按程序路径记，换安装位置、每次升级（ad-hoc 签名的 cdhash 会变）都要重新登记。所以 `ocs lan up`
监听非回环地址时会用 `socketfilterfw --add/--unblockapp` 放行 ocs 自己（当前用户自己的程序不需要 sudo），
登记失败时提示去 系统设置 › 网络 › 防火墙 手动允许。用 bun 跑源码时不代为放行 bun。
从 0.6.2 起发行版是 Developer ID 签名 + 公证的，防火墙的「自动允许下载的已签名软件」开着时本来就会放行。

## 登录自启

`ocs lan autostart on|off` 只写/删当前用户的登录项，不顺手启停：macOS 写
`~/Library/LaunchAgents/com.leeguooooo.ocs.lan.plist`（RunAtLoad，不 KeepAlive，`ocs lan down` 能真停），
Windows 写 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ocs-lan`（跑 `ocs.exe lan up`，不需要管理员，
而且落在用户自己的登录会话里——够得着 `LOCAL\` 管道），Linux 写 systemd user unit。换了安装位置
`ocs lan status` 会显示「失效」，重跑 `on` 即可。安装器（install.sh / install.ps1）发现守护进程在跑时会用新版重启它。

## 本机状态

```
$OCS_HOME/lan/            0700
  identity.json           Ed25519 私钥（PKCS#8），0600，首次使用时 O_EXCL 生成
  peers.json              信任库：label、公钥、指纹、自报名、最近地址；指纹必须能从公钥重算
  config.json             name / port / bind / discover
  offers/<id>.json        开着的配对邀请（令牌只存摘要）
  daemon.json             运行中守护进程的 pid / 端口 / 指纹
  daemon.log              连接与请求摘要（不含正文），1 MiB 轮转
```

重装丢了 `identity.json` 等于换了一台机器：对端会报「公钥不一致」的安全警告，需要
`ocs lan unpair <它>` 后重新配对。

## 已知限制 / 后续

- 远端 DM 不支持 `--notify-when-idle` / `--inherit`；`ocs send` 的 `@x@peer` 点名不跨机。
- 只有 IPv4 发现；TCP 可以 `--bind` 到 IPv6 地址但未专门测试。
- 授权是整机粒度，没有「只许对端找某几个会话」的细粒度 ACL。

## Machine-readable and quiet DM

`ocs dm <address>@<peer> <body> --json` emits one v1 JSON line. Confirmed commits
have `remote:true`, `stored:true`, and the **remote** channel/seq; wake is accepted,
deferred, parked, skipped, failed or unknown. The optional local history copy has its
own sequence and is not a delivery receipt. Refusal before storage is exit 1 with
stored:false. An unanswered or malformed response is exit 3 with remote:true,
stored:null and wake:unknown; remote commit is unknown and must never be retried.
Confirmed stored messages with failed wakes remain exit 2. Never resend exit 2/3.

`--no-wake` uses the authenticated `dm-quiet` operation, with the same target checks,
rate/quota limits and one-use trust consumption as dm. It appends the message but
skips delivery helpers, watchers and agy execution. Older receivers reject unknown-op
before storing; clients never fall back to ordinary dm. `--notify-when-idle` remains
incompatible with quiet delivery. `--inherit` and idle subscriptions remain local-only.

`who --lan --json` adds peers with optional versioned capabilities. Old remote receivers
may omit capabilities. See [traffic and batching](traffic.md) for fields and counting limits.
