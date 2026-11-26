#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""BiliBili 每日热榜采集与分析脚本（由 DSH 插件 bili-daily 调用）。

子命令:
  run     抓取昨日全站日榜前 N 视频 -> 写入 MySQL -> 清理过期数据 -> 生成词云与报告
  report  仅从 MySQL 重新生成报告（复用已有词云图）
  probe   环境自检：MySQL 连接、数据表、依赖、字体

数据归属: crawl_date = 运行日的前一天（B 站日榜每日 0 点更新，代表“上一天”的全站榜单）。
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import traceback
from collections import Counter
from pathlib import Path

DEFAULT_DATABASE = "BiliBili"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
RANKING_URL = "https://api.bilibili.com/x/web-interface/ranking/v2"
DETAIL_URL = "https://api.bilibili.com/x/web-interface/view/detail"
REPLY_URL = "https://api.bilibili.com/x/v2/reply"

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc",
]

# 词云配色：中高明度、高饱和，透明背景，亮/暗主题下都清晰。
PALETTE = ["#4f8ef7", "#ff6b6b", "#ffb020", "#34d399", "#a78bfa", "#f472b6", "#22d3ee"]

STOPWORDS = set(
    """
的 了 是 我 你 他 她 它 们 这 那 就 都 也 还 很 又 再 才 只 把 被 给 让 对 从 到 在 和 与 及 而 或
啊 吧 吗 呢 呀 哦 嗯 哈 呗 嘛 哇 诶 唉 哎 嘿 咦 额 咯 啦 喽 嚯 呵
一个 一些 一样 一直 一定 一般 一起 一下 一点 一切 一边 一次 一天 一年 这种 这个 这些 这样 这么 这里
那个 那些 那样 那么 那里 那种 什么 怎么 怎样 为什么 因为 所以 但是 可是 不过 然后 而且 虽然 如果
可以 可能 应该 需要 觉得 感觉 知道 时候 现在 已经 还是 就是 没有 不是 不会 不能 不要 不用 别的
自己 我们 你们 他们 大家 别人 有人 东西 事情 问题 地方 方式 方面 情况 真的 真是 实在 确实 其实
视频 主播 up UP Up 主 哔哩 哔哩哔哩 bilibili B站 站 关注 点赞 投币 收藏 转发 评论 弹幕 播放
哈哈哈哈 哈哈哈 哈哈 2333 666 233 23333 hhh hhhh 笑死 好看 厉害 牛 牛逼 太 好 真 都 整 弄 搞
""".split()
)

CLEAN_RE = re.compile(r"https?://\S+|www\.\S+|@[\w\u4e00-\u9fff-]+|\[[^\]]{1,8}\]")
PUNCT_RE = re.compile(r"[\s\u3000!-/:-@\[-`{-~\u3001-\u303f\uff00-\uffef\u2000-\u206f]+")


def log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------- 配置


def connect(host: str, port: int, user: str, password: str, database: str | None, autocommit: bool = False):
    import pymysql

    return pymysql.connect(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database,
        charset="utf8mb4",
        autocommit=autocommit,
        connect_timeout=8,
        read_timeout=30,
        write_timeout=30,
    )


def ensure_schema(host: str, port: int, user: str, password: str, database: str) -> None:
    conn = connect(host, port, user, password, None, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"CREATE DATABASE IF NOT EXISTS `{database}` "
                "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            )
    finally:
        conn.close()

    conn = connect(host, port, user, password, database, autocommit=True)
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS video (
                    id            INT NOT NULL AUTO_INCREMENT,
                    bv            VARCHAR(32)  NOT NULL,
                    category      VARCHAR(32)  DEFAULT NULL COMMENT '分区',
                    tag           TEXT         COMMENT '标签，逗号分隔',
                    time          DATETIME     DEFAULT NULL COMMENT '视频发布时间',
                    up            VARCHAR(128) DEFAULT NULL COMMENT 'UP 主昵称',
                    up_mid        BIGINT       DEFAULT NULL COMMENT 'UP 主 UID',
                    title         VARCHAR(255) DEFAULT NULL,
                    duration      INT          DEFAULT NULL COMMENT '时长（秒）',
                    play_count    BIGINT       DEFAULT NULL COMMENT '抓取时累计播放量',
                    like_count    BIGINT       DEFAULT NULL,
                    comment_count BIGINT       DEFAULT NULL,
                    rank_no       INT          DEFAULT NULL COMMENT '当日榜单位次',
                    crawl_date    DATE         NOT NULL COMMENT '数据归属日（榜单日）',
                    crawled_at    DATETIME     DEFAULT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uk_bv_crawl (bv, crawl_date),
                    KEY idx_crawl_date (crawl_date),
                    KEY idx_category (category)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """
            )
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS comment (
                    id         INT NOT NULL AUTO_INCREMENT,
                    bv         VARCHAR(32) NOT NULL,
                    content    TEXT,
                    like_count INT DEFAULT NULL,
                    author     VARCHAR(128) DEFAULT NULL,
                    rank_no    INT DEFAULT NULL COMMENT '热评位次 1..3',
                    crawl_date DATE NOT NULL,
                    crawled_at DATETIME DEFAULT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uk_bv_date_rank (bv, crawl_date, rank_no),
                    KEY idx_crawl_date (crawl_date)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """
            )
    finally:
        conn.close()


# --------------------------------------------------------------------------- 采集


def http_session():
    import requests

    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Referer": "https://www.bilibili.com/"})
    return s


def get_json(session, url: str, params: dict | None = None, retries: int = 3) -> dict:
    last: Exception | None = None
    for attempt in range(retries):
        try:
            resp = session.get(url, params=params, timeout=20)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"请求失败 {url}: {last}")


def fetch_ranking(session) -> list[dict]:
    data = get_json(session, RANKING_URL, {"rid": 0, "type": "all"})
    if data.get("code") != 0:
        raise RuntimeError(f"榜单接口返回 {data.get('code')}: {data.get('message')}")
    return (data.get("data") or {}).get("list") or []


def fetch_tags(session, bvid: str) -> tuple[list[str], int | None]:
    """返回 (标签列表, aid)。标签优先取 view/detail 的 Tags。"""
    tags: list[str] = []
    aid: int | None = None
    try:
        detail = get_json(session, DETAIL_URL, {"bvid": bvid})
        if detail.get("code") == 0:
            payload = detail.get("data") or {}
            tags = [t.get("tag_name") for t in payload.get("Tags") or [] if t.get("tag_name")]
            aid = (payload.get("View") or {}).get("aid")
    except Exception as exc:  # noqa: BLE001
        log(f"[warn] view/detail 失败 {bvid}: {exc}")
    if not tags:
        try:
            data = get_json(session, "https://api.bilibili.com/x/tag/archive/tags", {"bvid": bvid})
            if data.get("code") == 0:
                tags = [t.get("tag_name") for t in data.get("data") or [] if t.get("tag_name")]
        except Exception as exc:  # noqa: BLE001
            log(f"[warn] tag 接口失败 {bvid}: {exc}")
    return tags, aid


def fetch_comments(session, aid: int, limit: int = 3) -> list[dict]:
    try:
        data = get_json(session, REPLY_URL, {"type": 1, "oid": aid, "sort": 2, "ps": max(limit, 3), "pn": 1})
    except Exception as exc:  # noqa: BLE001
        log(f"[warn] 评论接口失败 aid={aid}: {exc}")
        return []
    if data.get("code") != 0:
        log(f"[warn] 评论接口返回 {data.get('code')}: {data.get('message')}")
        return []
    replies = ((data.get("data") or {}).get("replies")) or []
    out = []
    for rep in replies[:limit]:
        content = (rep.get("content") or {}).get("message") or ""
        out.append(
            {
                "content": content.strip(),
                "like": int(rep.get("like") or 0),
                "author": (rep.get("member") or {}).get("uname") or "",
            }
        )
    return out


def collect(session, top_n: int, crawl_date: dt.date) -> tuple[list[dict], list[dict]]:
    ranking = fetch_ranking(session)
    if not ranking:
        raise RuntimeError("榜单为空，可能被风控或接口变更")
    picked = ranking[:top_n]
    videos: list[dict] = []
    comments: list[dict] = []
    for index, item in enumerate(picked, start=1):
        bvid = item.get("bvid")
        if not bvid:
            continue
        stat = item.get("stat") or {}
        owner = item.get("owner") or {}
        tags, aid = fetch_tags(session, bvid)
        aid = aid or item.get("aid") or stat.get("aid")
        pub = item.get("pubdate")
        videos.append(
            {
                "bv": bvid,
                "category": (item.get("tname") or "").strip() or "未知",
                "tag": ",".join(tags),
                "time": dt.datetime.fromtimestamp(int(pub)) if pub else None,
                "up": owner.get("name") or "",
                "up_mid": int(owner.get("mid") or 0),
                "title": item.get("title") or "",
                "duration": int(item.get("duration") or 0),
                "play_count": int(stat.get("view") or 0),
                "like_count": int(stat.get("like") or 0),
                "comment_count": int(stat.get("reply") or 0),
                "rank_no": index,
                "crawl_date": crawl_date,
            }
        )
        if aid:
            for rank, comment in enumerate(fetch_comments(session, int(aid), 3), start=1):
                comments.append(
                    {
                        "bv": bvid,
                        "content": comment["content"],
                        "like_count": comment["like"],
                        "author": comment["author"],
                        "rank_no": rank,
                        "crawl_date": crawl_date,
                    }
                )
        time.sleep(0.4)
    return videos, comments


def store(host, port, user, password, database, videos, comments) -> None:
    conn = connect(host, port, user, password, database)
    now = dt.datetime.now()
    try:
        with conn.cursor() as cur:
            for v in videos:
                cur.execute(
                    """
                    INSERT INTO video (bv, category, tag, time, up, up_mid, title, duration,
                                       play_count, like_count, comment_count, rank_no, crawl_date, crawled_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                        category=VALUES(category), tag=VALUES(tag), time=VALUES(time), up=VALUES(up),
                        up_mid=VALUES(up_mid), title=VALUES(title), duration=VALUES(duration),
                        play_count=VALUES(play_count), like_count=VALUES(like_count),
                        comment_count=VALUES(comment_count), rank_no=VALUES(rank_no), crawled_at=VALUES(crawled_at)
                    """,
                    (
                        v["bv"], v["category"], v["tag"], v["time"], v["up"], v["up_mid"], v["title"],
                        v["duration"], v["play_count"], v["like_count"], v["comment_count"], v["rank_no"],
                        v["crawl_date"], now,
                    ),
                )
            for c in comments:
                cur.execute(
                    """
                    INSERT INTO comment (bv, content, like_count, author, rank_no, crawl_date, crawled_at)
                    VALUES (%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                        content=VALUES(content), like_count=VALUES(like_count),
                        author=VALUES(author), crawled_at=VALUES(crawled_at)
                    """,
                    (c["bv"], c["content"][:2000], c["like_count"], c["author"][:120], c["rank_no"], c["crawl_date"], now),
                )
        conn.commit()
    finally:
        conn.close()


def cleanup(host, port, user, password, database, retention_days: int) -> dict:
    cutoff = dt.date.today() - dt.timedelta(days=retention_days)
    conn = connect(host, port, user, password, database)
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM video WHERE crawl_date < %s", (cutoff,))
            removed_videos = cur.rowcount
            cur.execute("DELETE FROM comment WHERE crawl_date < %s", (cutoff,))
            removed_comments = cur.rowcount
        conn.commit()
    finally:
        conn.close()
    return {"cutoff": cutoff.isoformat(), "removedVideos": removed_videos, "removedComments": removed_comments}


# --------------------------------------------------------------------------- 文本与词云


def normalize_tags(tag_text: str | None) -> list[str]:
    if not tag_text:
        return []
    return [t.strip() for t in re.split(r"[,，]+", tag_text) if t.strip()]


def _cut(text: str) -> list[str]:
    import logging

    import jieba

    jieba.setLogLevel(logging.ERROR)
    return list(jieba.cut(text))


CJK_RE = re.compile(r"[\u4e00-\u9fff]")
BV_RE = re.compile(r"^[Bb][Vv][0-9A-Za-z]+$")
LATIN_OK = {"ai", "ar", "pc", "vr", "mv", "游戏", "ai"}


def tokenize(text: str) -> list[str]:
    cleaned = CLEAN_RE.sub(" ", text or "")
    cleaned = PUNCT_RE.sub(" ", cleaned)
    words = []
    for raw in _cut(cleaned):
        word = raw.strip()
        if len(word) < 2 or word in STOPWORDS or word.isdigit():
            continue
        if BV_RE.match(word) or any(ch.isdigit() for ch in word):
            continue
        if CJK_RE.search(word):
            words.append(word)
            continue
        # 纯英数词只保留有意义的短词，过滤噪声
        lowered = word.lower()
        if lowered in LATIN_OK or (len(word) >= 3 and word.isalpha()):
            words.append(lowered if lowered in LATIN_OK else word)
    return words


def counter_from(texts: list[str]) -> Counter:
    counter: Counter = Counter()
    for text in texts:
        counter.update(tokenize(text))
    return counter


TAG_SPLIT_RE = re.compile(r"[,，;；/\\|《》【】\[\]()（）#\s]+")


def tag_counter(tag_texts: list[str]) -> Counter:
    """按原始标签统计（标签本身即关键词），按分隔符拆开，不做分词。"""
    counter: Counter = Counter()
    for text in tag_texts:
        for tag in TAG_SPLIT_RE.split(text or ""):
            word = tag.strip(" :：.!！?？'\"“”")
            if len(word) < 2 or word in STOPWORDS:
                continue
            if word.isdigit() or BV_RE.match(word):
                continue
            counter[word] += 1
    return counter


def pick_font() -> str | None:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            return path
    return None


def render_wordcloud(counter: Counter, out_path: Path, font: str | None, fallback_text: str = "暂无数据") -> dict:
    from PIL import Image, ImageDraw, ImageFont
    from wordcloud import WordCloud

    out_path.parent.mkdir(parents=True, exist_ok=True)
    width, height = 1000, 520
    items = counter.most_common(150)
    if not items:
        img = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        try:
            font_obj = ImageFont.truetype(font, 34) if font else ImageFont.load_default()
        except Exception:  # noqa: BLE001
            font_obj = ImageFont.load_default()
        draw.text((width // 2, height // 2), fallback_text, font=font_obj, fill=(140, 140, 140, 200), anchor="mm")
        img.save(out_path)
        return {"words": 0, "path": out_path.name, "top": []}

    palette = PALETTE

    def color_func(word, font_size, position, orientation, random_state=None, **kwargs):  # noqa: ANN001
        return palette[hash(word) % len(palette)]

    cloud = WordCloud(
        font_path=font,
        width=width,
        height=height,
        background_color=None,
        mode="RGBA",
        max_words=150,
        prefer_horizontal=0.92,
        relative_scaling=0.45,
        collocations=False,
        margin=4,
        color_func=color_func,
        random_state=42,
    ).generate_from_frequencies(dict(items))
    cloud.to_file(str(out_path))
    return {"words": len(items), "path": out_path.name, "top": [[w, c] for w, c in items[:20]]}


# --------------------------------------------------------------------------- 报告


def query_rows(conn, sql: str, args: tuple = ()) -> list[dict]:
    with conn.cursor() as cur:
        cur.execute(sql, args)
        columns = [d[0] for d in cur.description]
        return [dict(zip(columns, row)) for row in cur.fetchall()]


def build_report(host, port, user, password, database, data_dir: Path, top_n: int, crawl_date: dt.date) -> dict:
    font = pick_font()
    conn = connect(host, port, user, password, database)
    try:
        today_rows = query_rows(
            conn,
            """
            SELECT bv, category, tag, time, up, up_mid, title, duration, play_count, like_count,
                   comment_count, rank_no, crawl_date
            FROM video WHERE crawl_date = %s ORDER BY rank_no ASC
            """,
            (crawl_date,),
        )
        today_comments = query_rows(
            conn,
            "SELECT bv, content, like_count, author, rank_no FROM comment WHERE crawl_date = %s ORDER BY bv, rank_no",
            (crawl_date,),
        )
        category_rows = query_rows(
            conn,
            "SELECT COALESCE(category, '未知') AS category, COUNT(*) AS count FROM video GROUP BY category ORDER BY count DESC, category ASC",
        )
        totals = query_rows(
            conn,
            """
            SELECT COUNT(*) AS videos, COUNT(DISTINCT crawl_date) AS days,
                   MIN(crawl_date) AS first_day, MAX(crawl_date) AS last_day
            FROM video
            """,
        )[0]
        comment_total = query_rows(conn, "SELECT COUNT(*) AS comments FROM comment")[0]["comments"]
        history_tags = [r["tag"] for r in query_rows(conn, "SELECT tag FROM video")]
        history_comments = [r["content"] for r in query_rows(conn, "SELECT content FROM comment")]
    finally:
        conn.close()

    images: dict[str, str] = {}
    word_stats: dict[str, object] = {}

    tag_today = tag_counter([v["tag"] for v in today_rows])
    tag_history = tag_counter(history_tags)
    images["tagToday"] = render_wordcloud(tag_today, data_dir / "wc_tag_today.png", font).get("path")
    word_stats["tagToday"] = tag_today.most_common(20)
    images["tagHistory"] = render_wordcloud(tag_history, data_dir / "wc_tag_history.png", font).get("path")
    word_stats["tagHistory"] = tag_history.most_common(20)

    cmt_today = counter_from([c["content"] for c in today_comments])
    cmt_history = counter_from(history_comments)
    images["commentToday"] = render_wordcloud(cmt_today, data_dir / "wc_cmt_today.png", font).get("path")
    word_stats["commentToday"] = cmt_today.most_common(20)
    images["commentHistory"] = render_wordcloud(cmt_history, data_dir / "wc_cmt_history.png", font).get("path")
    word_stats["commentHistory"] = cmt_history.most_common(20)

    per_video = []
    for video in today_rows:
        bv = video["bv"]
        texts = [c["content"] for c in today_comments if c["bv"] == bv]
        counter = counter_from(texts)
        name = f"wc_cmt_{bv}.png"
        render_wordcloud(counter, data_dir / name, font)
        per_video.append(
            {
                "bv": bv,
                "title": video["title"],
                "image": name,
                "comments": texts,
                "words": counter.most_common(15),
            }
        )

    videos = []
    for row in today_rows:
        tag_list = normalize_tags(row["tag"])
        videos.append(
            {
                "bv": row["bv"],
                "category": row["category"] or "未知",
                "tags": tag_list,
                "tag": row["tag"] or "",
                "title": row["title"] or "",
                "up": row["up"] or "",
                "upMid": int(row["up_mid"] or 0),
                "duration": int(row["duration"] or 0),
                "durationText": f"{int(row['duration'] or 0) // 60}:{int(row['duration'] or 0) % 60:02d}",
                "play": int(row["play_count"] or 0),
                "like": int(row["like_count"] or 0),
                "reply": int(row["comment_count"] or 0),
                "publishedAt": row["time"].isoformat(sep=" ") if row["time"] else None,
                "rank": int(row["rank_no"] or 0),
                "url": f"https://www.bilibili.com/video/{row['bv']}",
                "comments": [
                    {
                        "content": c["content"] or "",
                        "like": int(c["like_count"] or 0),
                        "author": c["author"] or "",
                        "rank": int(c["rank_no"] or 0),
                    }
                    for c in today_comments
                    if c["bv"] == row["bv"]
                ],
            }
        )

    report = {
        "ok": True,
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "crawlDate": crawl_date.isoformat(),
        "topN": top_n,
        "videos": videos,
        "history": {
            "videos": int(totals["videos"] or 0),
            "days": int(totals["days"] or 0),
            "comments": int(comment_total or 0),
            "firstDay": str(totals["first_day"]) if totals["first_day"] else None,
            "lastDay": str(totals["last_day"]) if totals["last_day"] else None,
            "categories": [{"category": r["category"], "count": int(r["count"])} for r in category_rows],
        },
        "images": images,
        "videoImages": per_video,
        "wordStats": word_stats,
        "analysis": "",
    }
    cached_analysis = data_dir / f"analysis-{crawl_date.isoformat()}.json"
    if cached_analysis.exists():
        try:
            report["analysis"] = json.loads(cached_analysis.read_text(encoding="utf-8")).get("text", "")
        except Exception:  # noqa: BLE001
            pass
    return report


# --------------------------------------------------------------------------- 入口


def base_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host", default=os.environ.get("BILI_DB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("BILI_DB_PORT", "3306")))
    parser.add_argument("--user", default=os.environ.get("BILI_DB_USER", "root"))
    parser.add_argument("--password", default=os.environ.get("BILI_DB_PASSWORD", ""))
    parser.add_argument("--database", default=os.environ.get("BILI_DB_NAME", DEFAULT_DATABASE))
    parser.add_argument("--data-dir", default=os.environ.get("BILI_DATA_DIR") or str(Path(__file__).resolve().parent.parent / "data"))
    parser.add_argument("--top-n", type=int, default=int(os.environ.get("BILI_TOP_N", "5")))
    parser.add_argument("--retention-days", type=int, default=int(os.environ.get("BILI_RETENTION_DAYS", "15")))
    parser.add_argument("--date", default="", help="数据归属日 YYYY-MM-DD，默认昨天")
    parser.add_argument("--out", default="", help="报告 JSON 输出路径，默认 <data-dir>/report.json")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="BiliBili 每日热榜采集与分析")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("run", "report", "probe"):
        p = sub.add_parser(name)
        base_args(p)
        if name == "run":
            p.add_argument("--skip-crawl", action="store_true")
    args = parser.parse_args(argv)

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    crawl_date = dt.date.fromisoformat(args.date) if args.date else dt.date.today() - dt.timedelta(days=1)
    out_path = Path(args.out) if args.out else data_dir / "report.json"

    try:
        if args.command == "probe":
            import pymysql  # noqa: F401
            import jieba  # noqa: F401
            import wordcloud  # noqa: F401
            import requests  # noqa: F401

            ensure_schema(args.host, args.port, args.user, args.password, args.database)
            conn = connect(args.host, args.port, args.user, args.password, args.database)
            try:
                version = query_rows(conn, "SELECT VERSION() AS v")[0]["v"]
                tables = [
                    r["TABLE_NAME"]
                    for r in query_rows(
                        conn,
                        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = %s ORDER BY TABLE_NAME",
                        (args.database,),
                    )
                ]
            finally:
                conn.close()
            result = {
                "ok": True,
                "mysql": version,
                "database": args.database,
                "tables": tables,
                "font": pick_font(),
                "python": sys.version.split()[0],
                "dataDir": str(data_dir),
            }
            print(json.dumps(result, ensure_ascii=False))
            return 0

        if args.command == "run":
            if not args.skip_crawl:
                session = http_session()
                log(f"[bili] 抓取 {crawl_date} 全站日榜前 {args.top_n} ...")
                videos, comments = collect(session, args.top_n, crawl_date)
                ensure_schema(args.host, args.port, args.user, args.password, args.database)
                store(args.host, args.port, args.user, args.password, args.database, videos, comments)
                log(f"[bili] 写入 {len(videos)} 条视频、{len(comments)} 条评论")
            ensure_schema(args.host, args.port, args.user, args.password, args.database)
            removed = cleanup(args.host, args.port, args.user, args.password, args.database, args.retention_days)
            log(f"[bili] 清理早于 {removed['cutoff']} 的数据：视频 {removed['removedVideos']} 条，评论 {removed['removedComments']} 条")
            report = build_report(
                args.host, args.port, args.user, args.password, args.database, data_dir, args.top_n, crawl_date
            )
            report["cleanup"] = removed
            out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"ok": True, "report": str(out_path), "crawlDate": crawl_date.isoformat()}, ensure_ascii=False))
            return 0

        if args.command == "report":
            report = build_report(
                args.host, args.port, args.user, args.password, args.database, data_dir, args.top_n, crawl_date
            )
            out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(json.dumps({"ok": True, "report": str(out_path)}, ensure_ascii=False))
            return 0

        parser.error("unknown command")
        return 2
    except Exception as exc:  # noqa: BLE001
        print(
            json.dumps(
                {"ok": False, "error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc(limit=6)},
                ensure_ascii=False,
            )
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
