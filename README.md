# B站每日热榜 · DSH 插件

> 每天把 B 站"全站日榜"搬进你的数据库和看板。用全站热榜，替代只喂给你的那一小块推荐。

你的首页由个性化推荐决定，而日榜是**全站所有人共同投出来的结果**。这个插件每天抓一次日榜，把视频、分区、标签、UP 主和热评归档到 MySQL，画成词云和分区分布图，再让大模型写一份简报——用来观察"全网都在看什么"，而不是"算法觉得你想看什么"。

![预览](docs/preview.png)

## 功能

- **每天采集**：抓昨日全站日榜前 N（默认 5）条，补全 BV 号、分区、标签、时长、UP 主与 UID、播放/点赞/评论数。
- **热评**：每条视频抓按热度排序的前 3 条评论。
- **MySQL 归档**：库 `BiliBili`，表 `video` / `comment`，按 `(bv, crawl_date)` 去重，滚动保留 15 天。
- **数据分析**：
  1. 当日 Top N 汇总表（BV 号 / 分区 / 标签，附 UP 主、时长、播放量）；
  2. 历史各分区视频数量条形图；
  3. 当日标签词云 + 历史标签词云；
  4. 每条视频的评论词云（N 张）+ 当日评论汇总词云 + 历史评论汇总词云；
  5. 大模型生成的中文数据简报。
- **DSH 内页面**：侧边栏底部「B站日报」打开全屏看板，支持只读刷新、重新采集、单独重生成分析。
- **Agent 可调用**：会话里让 Agent 调 `bili_daily`（`status` / `run` / `report`），也可以定时让它跑。
- **自动运行**：插件激活 8 秒后检查昨日数据是否已采，未采则自动跑；之后每 30 分钟复查，跨天自动补采。

## 架构

```
Host 半 (index.js)
  ├─ spawn python bili_daily.py run
  │     ├─ 抓日榜前 N + 标签 + 前 3 热评
  │     ├─ 写入 MySQL（video / comment）
  │     ├─ 清理 15 天前的数据
  │     └─ 生成 data/report.json 与 9 张词云 PNG
  ├─ ctx.llm 生成分析文本，回写 report.json
  ├─ HTTP：GET /bili-daily/api/report       报告与运行状态
  │         POST /bili-daily/api/run        启动采集（?force=1 跳过"今日已采"）
  │         POST /bili-daily/api/analyze    只重生成分析
  │         GET  /bili-daily/assets/*.png   词云图片
  └─ Agent 工具 bili_daily

Client 半 (client.js)
  └─ 侧边栏入口 + 全屏看板（fetch 同源接口）
```

## 环境要求

- **DSH Desktop**（本插件是 DSH bundle，需要 Web 端）
- **MySQL 8.x**（本机已运行，账号需具备建库建表权限）
- **Python 3.10+**，安装以下依赖：

```bash
pip install requests pymysql jieba wordcloud pillow
```

> Windows 下推荐直接用 Anaconda 自带环境；`wordcloud` 有官方 wheel，不需要编译。

## 安装

1. 克隆本仓库到任意目录：

   ```bash
   git clone https://github.com/<your-name>/dsh-bili-daily.git
   cd dsh-bili-daily
   ```

2. 安装 Python 依赖（见上一节）。

3. 修改 `cordis.patch.yml`，至少填上 MySQL 密码和 Python 路径：

   ```yaml
   config:
     pythonPath: ''            # 留空则用 PATH 里的 python
     mysqlUser: 'root'
     mysqlPassword: '你的密码'
     topN: 5
   ```

   ⚠️ 再次提醒：填完密码后执行 `git update-index --skip-worktree cordis.patch.yml`，避免误提交。

4. 打开 DSH → **Plugins** → **Add plugin / 添加本地插件目录** → 选择本目录。

5. 刷新 DSH 页面，侧边栏底部出现「B站日报」即安装成功。

首次激活会自动采集一次；也可以打开看板点「重新采集」。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `pythonPath` | 空 | Python 解释器；空则用 PATH 中的 `python` |
| `mysqlHost` / `mysqlPort` | `127.0.0.1` / `3306` | MySQL 地址 |
| `mysqlUser` / `mysqlPassword` | `root` / 空 | 需具备建库建表权限 |
| `database` | `BiliBili` | 库名，不存在时自动创建 |
| `topN` | `5` | 每日保留条数 |
| `retentionDays` | `15` | 数据保留天数 |
| `dataDir` | 包内 `data/` | 报告、词云、分析缓存目录 |
| `provider` / `model` | 空 | 分析用模型；留空用 DSH 默认模型 |
| `autoRun` | `true` | 启动与跨天自动采集 |

## 数据表

```sql
CREATE DATABASE IF NOT EXISTS `BiliBili`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE video (
  id            INT NOT NULL AUTO_INCREMENT,
  bv            VARCHAR(32)  NOT NULL,
  category      VARCHAR(32)              COMMENT '分区',
  tag           TEXT                     COMMENT '标签，逗号分隔',
  time          DATETIME                 COMMENT '视频发布时间',
  up            VARCHAR(128)             COMMENT 'UP 主昵称',
  up_mid        BIGINT                   COMMENT 'UP 主 UID',
  title         VARCHAR(255),
  duration      INT                      COMMENT '时长（秒）',
  play_count    BIGINT                   COMMENT '抓取时累计播放量',
  like_count    BIGINT,
  comment_count BIGINT,
  rank_no       INT                      COMMENT '当日榜单位次',
  crawl_date    DATE NOT NULL            COMMENT '数据归属日（榜单日）',
  crawled_at    DATETIME,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bv_crawl (bv, crawl_date),
  KEY idx_crawl_date (crawl_date),
  KEY idx_category (category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE comment (
  id         INT NOT NULL AUTO_INCREMENT,
  bv         VARCHAR(32) NOT NULL,
  content    TEXT,
  like_count INT,
  author     VARCHAR(128),
  rank_no    INT                      COMMENT '热评位次 1..3',
  crawl_date DATE NOT NULL,
  crawled_at DATETIME,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bv_date_rank (bv, crawl_date, rank_no),
  KEY idx_crawl_date (crawl_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

## Agent 工具

| action | 作用 |
| --- | --- |
| `status` | 采集状态、数据概况、分区分布 |
| `run` | 后台启动采集（立即返回，不阻塞会话） |
| `report` | 最新报告摘要（含模型分析） |

## 目录结构

```
.
├── index.js                 # Host 半：调度、LLM、HTTP、工具
├── client.js                # Client 半：入口按钮 + 数据看板
├── cordis.patch.yml         # 插件行配置（含你的 MySQL 密码，勿提交）
├── python/bili_daily.py     # 采集 / 入库 / 清理 / 词云 / 报告
├── docs/DETAIL.md           # 详细说明与接口
├── docs/preview.png         # 示意图（合成词云，不含真实用户数据）
├── locale/                  # 插件标题与描述（中/英）
└── icon.svg
```

## 常见问题

**打开看板显示"数据库中还没有可展示的数据"？**
点「重新采集」；若仍失败，看页面顶部错误条——通常是 MySQL 密码、Python 路径或 B 站接口被风控。

**"当日播放量"是怎么算的？**
B 站没有公开的"某视频当日播放量"接口。本插件取**全站日榜前 N**（日榜每日 0 点更新，按综合得分排序），表中展示的 `play_count` 是累计播放量，不用它排序。

**词云显示成方块？**
词云需要中文字体，脚本会优先用 `C:\Windows\Fonts\msyh.ttc`；Linux/macOS 可在脚本里改 `FONT_CANDIDATES`。

**历史图表只有一天数据？**
正常。每天自动采集一次，15 天后才有完整的趋势样本。

## 合规与免责

- 只调用 B 站**公开**接口，不登录、不绕过风控、不采集用户隐私数据。
- 请控制采集频率（默认每天一次），不要用于商业转载、批量分发或对抗平台规则。
- 数据与内容版权归 B 站及原作者所有；本项目仅用于个人数据分析与研究。

## License

MIT
