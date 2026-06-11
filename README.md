# SMS Forwarder

基于 Node.js 的短信转发网关，通过 AT 指令控制银尔达 U724U (Air724UG) 4G 模块接收短信，自动提取验证码并推送通知（默认 Bark，支持飞书）。

## 硬件架构

```
giffgaff SIM
      ↓
U724U (Air724UG)
      ↓ USB
N1 (Armbian)
      ↓
家庭宽带
      ↓
Bark / 飞书
```

**说明：** 短信接收不消耗 SIM 卡流量，通知通过 N1 的家庭宽带发送。启动时会自动关闭模块的 RNDIS USB 网卡，防止 N1 意外通过 SIM 卡上网。

## 功能

- 实时接收短信并推送通知（Bark / 飞书）
- 自动提取 4~8 位验证码（支持中英文关键词识别）
- Bark 推送验证码时自动复制到剪贴板，设为时效性通知穿透勿扰模式
- 启动时扫描未读短信并补推（不漏消息）
- 短信去重（phone + content + timestamp hash）
- SQLite 日志记录
- 串口断开自动重连（指数退避）
- CNMI 定时刷新（防止模块重置通知配置）
- SIM 存储满自动清理
- 优雅退出（SIGINT/SIGTERM）
- 支持 PM2 / systemd 部署

## 前置条件

- Node.js >= 22
- N1 (Armbian) 或其他 Linux 设备
- 银尔达 U724U (Air724UG) 4G 模块
- giffgaff SIM 卡（或其他 SIM 卡）

---

## N1 完整部署步骤

### 1. 安装 Node.js 22

```bash
# SSH 登录到 N1
ssh root@<N1-IP>

# 安装编译工具（better-sqlite3 需要）
apt update && apt install -y build-essential python3 git screen

# 方案 A：通过 NodeSource 安装（推荐）
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node -v  # 应显示 v22.x.x

# 方案 B：通过 fnm 安装
curl -fsSL https://fnm.vercel.app/install | bash
source ~/.bashrc
fnm install 22
fnm use 22
```

### 2. 确定串口路径

将 U724U 模块通过 USB 连接到 N1，查看串口设备：

```bash
ls /dev/ttyUSB*
# 通常输出: /dev/ttyUSB0 /dev/ttyUSB0 /dev/ttyUSB2 /dev/ttyUSB3
```

Air724UG 通常注册 4 个串口，AT 指令口一般是 `ttyUSB0` 或 `ttyUSB2`。逐个测试：

```bash
screen /dev/ttyUSB0 115200
```

输入以下指令确认：

```
AT          → OK
AT+CPIN?    → +CPIN: READY
AT+CSQ      → +CSQ: 20,99 （第一个数字 10+ 为正常信号）
```

按 `Ctrl+A` 然后 `K`，输入 `y` 退出 screen。

> **提示：** 如果 `screen` 没反应，换下一个 ttyUSB 试。记住哪个端口返回了 OK。

### 3. 克隆仓库并安装

```bash
cd /opt
git clone https://github.com/Evansy/sms-forwarder-nodejs.git sms-forwarder
cd sms-forwarder
npm install
```

> ARM64 上 `better-sqlite3` 会触发编译，可能需要几分钟，看到 `gyp` 输出是正常的。

### 4. 配置环境变量

```bash
cp .env.example .env
nano .env
```

按实际情况修改：

```env
# 串口路径（改成第 2 步测出的端口）
SERIAL_PORT=/dev/ttyUSB0
BAUD_RATE=115200

# 通知渠道
NOTIFIER=bark

# Bark 配置
BARK_SERVER_URL=https://api.day.app
BARK_KEY=your_bark_key_here
BARK_GROUP=sms

# 飞书（如果用飞书则设置 NOTIFIER=feishu）
# FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/xxxx

DELETE_SMS_AFTER_FORWARD=true
CNMI_REFRESH_INTERVAL=60000
LOG_LEVEL=info
```

保存退出（`Ctrl+O` 回车，`Ctrl+X`）。

### 5. 串口权限

```bash
# 方案 A：临时修改（重启后失效）
chmod 666 /dev/ttyUSB0

# 方案 B：持久化 udev 规则（推荐）
cat > /etc/udev/rules.d/99-usb-serial.rules << 'EOF'
# Air724UG USB serial ports
SUBSYSTEM=="tty", ATTRS{idVendor}=="1782", MODE="0666"
EOF

udevadm control --reload-rules
# 重新拔插 USB 线使规则生效
```

查看 USB 设备 vendor ID：

```bash
lsusb | grep -i "1782\|airm2m\|luat"
```

如果 vendor ID 不是 `1782`，把规则中的 `1782` 改成实际值。

### 6. 测试运行

```bash
cd /opt/sms-forwarder
node src/app.js
```

正常输出：

```
[INFO] 配置校验通过
[INFO] 串口已打开 port="/dev/ttyUSB0" baudRate=115200
[INFO] AT 通信正常
[INFO] 已设置文本模式 (AT+CMGF=1)
[INFO] 已关闭 RNDIS 网卡 (AT+RNDISCALL=0,0)
[INFO] 已开启短信通知 (AT+CNMI=2,1,0,0,0)
[INFO] 已设置短信存储区 (SM)
[INFO] 信号强度 csq="+CSQ: 20,99"
[INFO] SIM 卡状态 cpin="+CPIN: READY"
[INFO] 无未读短信
[INFO] SMS Forwarder 启动完成，等待短信...
```

此时给 giffgaff SIM 卡发一条短信，应该能看到：

```
[INFO] 收到新短信通知 index=0
[INFO] 处理新短信 phone="+44xxx" otp="123456"
[INFO] Bark 通知发送成功
```

手机 Bark App 也会收到推送。确认无误后 `Ctrl+C` 停止。

### 7. 部署为系统服务

二选一：PM2 或 systemd。

#### 方案 A：PM2（推荐，管理方便）

```bash
# 安装 PM2
npm install -g pm2

# 启动
cd /opt/sms-forwarder
pm2 start ecosystem.config.cjs

# 查看状态
pm2 status
pm2 logs sms-forwarder

# 设置开机自启
pm2 startup
# 按提示执行输出的命令（通常是一行 systemctl 命令）
pm2 save
```

PM2 常用命令：

```bash
pm2 restart sms-forwarder    # 重启
pm2 stop sms-forwarder       # 停止
pm2 logs sms-forwarder       # 查看日志
pm2 monit                    # 实时监控
```

#### 方案 B：systemd

```bash
# 复制 service 文件
cp /opt/sms-forwarder/sms-forwarder.service /etc/systemd/system/

# 确认 node 路径（重要！）
which node
# 如果输出不是 /usr/bin/node，需要修改 service 文件中的 ExecStart
# 例如 fnm 安装的 node 路径可能是 /root/.local/share/fnm/aliases/default/bin/node
nano /etc/systemd/system/sms-forwarder.service
# 将 ExecStart 中的 /usr/bin/node 改成实际路径

# 启用并启动
systemctl daemon-reload
systemctl enable sms-forwarder
systemctl start sms-forwarder

# 查看状态
systemctl status sms-forwarder

# 查看实时日志
journalctl -u sms-forwarder -f
```

systemd 常用命令：

```bash
systemctl restart sms-forwarder   # 重启
systemctl stop sms-forwarder      # 停止
journalctl -u sms-forwarder -n 50 # 最近 50 行日志
```

### 8. 验证部署

```bash
# 确认服务在运行
# PM2:
pm2 status

# systemd:
systemctl status sms-forwarder

# 确认串口被占用
lsof /dev/ttyUSB0
# 应显示 node 进程

# 发一条短信测试
# 用另一部手机给 giffgaff 号码发短信
# 检查 Bark App 是否收到推送

# 检查日志
cat /opt/sms-forwarder/logs/app.log | tail -20

# 模拟重启测试
reboot
# 重启后确认服务自动启动
```

---

## 配置说明

### 配置 Bark（默认）

1. App Store 下载 [Bark](https://apps.apple.com/app/bark-custom-notifications/id1403753865)
2. 打开 App，复制推送 URL（格式如 `https://api.day.app/YourKeyHere`）
3. 提取 Key 填入 `.env` 的 `BARK_KEY`
4. 可选修改 `BARK_GROUP` 用于通知分组

Bark 特性：

- 验证码自动复制到剪贴板
- 验证码类短信设为时效性通知，可穿透勿扰模式
- 按 group 分组归档

### 配置飞书机器人

1. `.env` 中设置 `NOTIFIER=feishu`
2. 打开飞书，进入目标群聊
3. 群设置 → 群机器人 → 添加机器人 → 自定义机器人
4. 设置名称，复制 Webhook URL
5. 粘贴到 `.env` 的 `FEISHU_WEBHOOK`

---

## 项目结构

```
sms-forwarder/
├── src/
│   ├── config/
│   │   └── index.js          # 配置加载与校验
│   ├── serial/
│   │   ├── modem.js           # 串口通信、AT 指令队列、自动重连
│   │   └── parser.js          # AT 响应解析（+CMTI/+CMGR/+CMGL）
│   ├── sms/
│   │   ├── sms.service.js     # 短信处理编排（核心）
│   │   ├── sms.parser.js      # 短信内容解析
│   │   └── otp.js             # OTP 验证码提取
│   ├── notifier/
│   │   ├── bark.js            # Bark 通知（默认）
│   │   └── feishu.js          # 飞书通知
│   ├── database/
│   │   └── sqlite.js          # SQLite 操作
│   ├── logger/
│   │   └── index.js           # pino 日志
│   └── app.js                 # 主入口
├── data/                      # SQLite 数据库（自动创建）
├── logs/                      # 日志文件（自动创建）
├── sms-forwarder.service      # systemd service 文件
├── .env.example
├── ecosystem.config.cjs       # PM2 配置
├── package.json
└── README.md
```

## 工作流程

```
+CMTI 新短信通知
    ↓
AT+CMGR 读取短信
    ↓
解析内容 + 提取验证码
    ↓
SHA256 去重检查
    ↓
Bark/飞书 推送通知
    ↓
SQLite 记录日志
    ↓
AT+CMGD 删除短信
```

启动时额外执行 `AT+CMGL="REC UNREAD"` 扫描所有未读短信并补推，确保服务停机期间收到的短信不会遗漏。

---

## 故障排查

### 串口打不开

```bash
# 检查设备是否识别
lsusb
ls /dev/ttyUSB*

# 如果没有 ttyUSB，检查内核模块
lsmod | grep option
# 如果没有，加载模块
modprobe option

# 检查权限
ls -la /dev/ttyUSB*
chmod 666 /dev/ttyUSB0
```

### 收不到短信通知

```bash
# 手动测试 AT 指令
screen /dev/ttyUSB0 115200

AT          # 应返回 OK
AT+CPIN?    # 应返回 +CPIN: READY
AT+CSQ      # 信号强度，第一个数字 10+ 为正常
AT+CMGF=1   # 设置文本模式
AT+CNMI=2,1,0,0,0  # 开启通知

# 此时发短信，screen 中应出现 +CMTI: "SM",0
```

### 短信存储满

SIM 卡通常只有 40 条容量。服务会自动处理存储满事件，如需手动清理：

```bash
# 在 screen/minicom 中
AT+CMGD=1,4    # 删除所有短信
```

### N1 重启后服务不启动

```bash
# PM2
pm2 status
# 如果没有运行，检查 startup 是否配置
pm2 startup
pm2 save

# systemd
systemctl status sms-forwarder
systemctl is-enabled sms-forwarder
# 如果不是 enabled
systemctl enable sms-forwarder
```

### 通知发送失败

**Bark：**

1. 检查 `BARK_KEY` 是否正确
2. 测试：`curl https://api.day.app/YourKey/测试推送`
3. 检查 N1 网络：`ping api.day.app`
4. 查看日志：`grep "Bark" /opt/sms-forwarder/logs/app.log`

**飞书：**

1. 检查 Webhook URL 是否正确
2. 检查 N1 是否能访问飞书 API：`curl -I https://open.feishu.cn`
3. 查看日志：`grep "飞书" /opt/sms-forwarder/logs/app.log`

### USB 掉线后服务恢复

服务内置自动重连机制（5s → 10s → 20s → 30s 指数退避）。如果模块完全失联：

```bash
# 查看 USB 设备
lsusb

# 如果模块消失，尝试重新插拔 USB 线
# 或重置 USB 总线
echo "0" > /sys/bus/usb/devices/usb1/authorized
sleep 2
echo "1" > /sys/bus/usb/devices/usb1/authorized
```

---

## 扩展通知渠道

通知模块已抽象为 `{ send(message) }` 接口，新增渠道只需：

1. 在 `src/notifier/` 下新建文件（如 `telegram.js`）
2. 实现 `send(message)` 方法
3. 在 `src/config/index.js` 中添加配置和校验
4. 在 `src/sms/sms.service.js` 中添加动态加载逻辑

预留支持：Telegram、PushDeer、企业微信、邮件。

## License

MIT
