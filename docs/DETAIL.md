# B站每日热报（bili-daily）

每天抓取 B 站**昨日全站日榜前 N**（默认 5）视频，写入 MySQL，滚动保留 15 天，并生成标签/评论词云、历史分区条形图与大模型分析；这些内容在 DSH Web 端一个独立的全屏看板页面中展示。

## 功能

- **采集**：`api.bilibili.com/x/web-interface/ranking/v2`（全站日榜）取前 N 条，逐条补抓
  `view/detail`（标签）与 `x/v2/reply?sort=2`（按热度排序的前 3 条评论）。
- **入库**：MySQL 库 `BiliBili`，表 `video`（BV 号、分区、标签、发布时间、时长、UP 主与 UID、播放/点赞/评论数、榜单位次、数据归属日）与
  `comment`（BV 号、评论内容、点赞数、作者、热评位次、数据归属日）。
- **滚动清理**：每次采集后删除 `crawl_date` 早于「今天 − 15 天」的记录。
- **分析**：
  1. 当日 Top N 汇总表（BV 号、分区、标签，附 UP 主/时长/播放量）；
  2. 历史各分区视频数量条形图；
  3. 当日标签词云 + 历史标签词云；
  4. 当日每条视频的评论词云（N 个）+ 当日评论汇总词云 + 历史评论汇总词云；
  5. 由当前 DSH 默认模型生成的中文数据简报。
- **入口**：左侧边栏底部的「B站日报」按钮打开全屏看板；也可在会话中调用 Agent 工具 `bili_daily`。
- **自动运行**：插件激活 8 秒后检查「昨日数据是否已采集」，未采集则自动跑一次；之后每 30 分钟复查，跨天自动补采。

## 配置

插件不自带配置界面，配置写在插件行的 `config` 中：

- 本目录的 `cordis.patch.yml`（安装后即生效，改完重启 DSH）；
- 或在 profile 的 `cordis.patch.yml` 追加一项 `- id: bili-daily` 的 `config:` 覆盖。

未写出的字段使用内置默认值（因此可以只覆盖需要改的字段）。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `pythonPath` | 空（用 PATH 中的 `python`） | 运行采集脚本的 Python（需 requests、pymysql、jieba、wordcloud、pillow） |
| `mysqlHost` / `mysqlPort` | `127.0.0.1` / `3306` | MySQL 地址 |
| `mysqlUser` / `mysqlPassword` | `root` / 空 | 具备建库建表权限的账号 |
| `database` | `BiliBili` | 库名，不存在时自动创建 |
| `topN` | `5` | 每日保留的榜单条数 |
| `retentionDays` | `15` | 数据保留天数 |
| `dataDir` | 包内 `data/` | 报告 JSON、词云 PNG、分析缓存目录 |
| `provider` / `model` | 空 | 分析用模型路由；留空则用 DSH 默认模型（当前为 `deepseek-account` / `deepseek-flash`） |
| `autoRun` | `true` | 启动与跨天自动采集 |

## 数据表

在原参考 SQL 的基础上修正了 id 自增、UP 名长度、字符集与索引（`utf8mb4` 以保存表情评论）：

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

## 使用

1. 侧边栏底部点击「B站日报」打开看板：
   - 「刷新」只重读磁盘上的报告，不抓取、不调用模型；
   - 「重新采集」会二次确认，然后重抓日榜 → 入库 → 清理 → 重绘词云 → 重新生成分析（约 1-3 分钟）；
   - 分析区底部「重新生成分析」只重跑模型分析，不重抓数据；
   - 「关闭」或 Esc 返回会话。
2. 会话中让 Agent 调用 `bili_daily`：
   - `action=status` 查看采集状态与数据概况；
   - `action=run` 后台启动采集（立即返回，不阻塞会话）；
   - `action=report` 获取最新报告摘要（含模型分析）。

## 内部接口

浏览器端只访问同源接口；`run` / `analyze` 只接受同源 `POST`（校验 `Origin` 与 `Sec-Fetch-Site`），
避免任意网页通过 `<img>` 或跨站表单触发抓取与模型调用。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/bili-daily/api/report` | 当前报告、分析文本与运行状态 |
| POST | `/bili-daily/api/run` | 启动采集；`?force=1` 跳过「今日已采集」短路 |
| POST | `/bili-daily/api/analyze` | 仅重新生成模型分析 |
| GET | `/bili-daily/assets/<file>.png` | 词云图片（文件名白名单校验） |

## 数据流

```
Host 半 (index.js)
  └─ spawn python bili_daily.py run
        ├─ 抓取日榜前 N + 标签 + 前 3 热评
        ├─ 写入 MySQL（video / comment）
        ├─ 清理 15 天前的数据
        └─ 生成 data/report.json 与词云 PNG
  └─ ctx.llm 生成分析文本并写回 report.json
Client 半 (client.js)
  └─ fetch /bili-daily/api/report、/bili-daily/assets/*.png 渲染看板
```

## 限制

- B 站没有公开的“某视频当日播放量”接口：日榜（`ranking/v2`）按综合得分排序，`stat.view` 是累计播放量。本插件取**日榜前 N**作为“当日最热”，并在表中同时展示累计播放量，不做累计播放量排序。
- 日榜每日 0 点更新，因此数据归属日固定为运行日的前一天。
- 采集依赖公网访问 B 站 API；接口风控、Cookie 要求或字段变更会导致失败，失败原因会显示在插件状态与看板页头。
- 评论取 B 站“按热度排序”的前 3 条，可能包含 UP 主回复或置顶评论。
- 需本机已安装并运行 MySQL 8.x；插件不负责安装 MySQL。
