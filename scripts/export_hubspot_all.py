#!/usr/bin/env python3
"""Export EVERYTHING readable from the HubSpot accounts into one SQLite file.

READ-ONLY: only GET requests plus POST /search and POST .../batch/read (both
are reads). Nothing is ever written to HubSpot.

Tokens come from environment variables or the .env next to package.json:
  HUBSPOT_TOKEN    -> account A (nsign)
  HUBSPOT_TOKEN_B  -> account B
Tokens are never printed or stored in the database.

Tables: objects, associations, properties_meta, attachments, misc, export_log.
Every object keeps ALL its properties as JSON (empty ones skipped), so nothing
has to be re-exported when a new field becomes interesting. Views v_companies,
v_contacts, v_deals, v_crosswalk flatten the common cases.

Re-running is safe: finished (account, type) pairs are skipped unless --force,
and records are upserted by (account, type, id).
"""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = os.environ.get("HUBSPOT_API_BASE", "https://api.hubapi.com")
DEFAULT_DRIVE_DIR = ("/Users/leandrobraier/Library/CloudStorage/GoogleDrive-mmasia@nsign.tv/"
                     "Unidades compartidas/Marketing/MKT-nsign/Projectes/HS to Brevo")
ACCOUNT_ENV = {"A": "HUBSPOT_TOKEN", "B": "HUBSPOT_TOKEN_B"}
ENGAGEMENTS = ["emails", "notes", "tasks", "calls", "meetings", "communications"]
OBJECT_TYPES = [
    "companies", "contacts", "deals", "tickets", "line_items", "products", "quotes",
    *ENGAGEMENTS, "postal_mail", "feedback_submissions", "leads", "orders", "carts",
    "invoices", "subscriptions", "appointments", "courses", "listings", "services",
    "contracts", "projects", "goals", "marketing_events", "partner_clients", "partner_services",
    "discounts", "fees", "taxes", "commerce_payments",
]
ASSOC_PAIRS = (
    [("companies", t) for t in ("contacts", "deals", "tickets", "companies")]
    + [("contacts", t) for t in ("companies", "deals", "tickets")]
    + [("deals", t) for t in ("contacts", "companies", "line_items", "quotes", "tickets")]
    + [("tickets", t) for t in ("contacts", "companies", "deals")]
    + [("quotes", "deals"), ("quotes", "line_items"), ("line_items", "deals")]
    + [(e, t) for e in ENGAGEMENTS for t in ("contacts", "companies", "deals", "tickets")]
)
# (name, method, path, params/body, results key, paging style)
MISC = [
    ("owners", "GET", "/crm/v3/owners", {"limit": 500}, "results", "after"),
    ("owners_archived", "GET", "/crm/v3/owners", {"limit": 500, "archived": "true"}, "results", "after"),
    ("pipelines_deals", "GET", "/crm/v3/pipelines/deals", None, "results", None),
    ("pipelines_tickets", "GET", "/crm/v3/pipelines/tickets", None, "results", None),
    ("schemas_custom_objects", "GET", "/crm/v3/schemas", None, "results", None),
    ("forms", "GET", "/marketing/v3/forms", {"limit": 100}, "results", "after"),
    ("marketing_emails", "GET", "/marketing/v3/emails", {"limit": 100}, "results", "after"),
    ("lists", "POST", "/crm/v3/lists/search", {"query": "", "count": 500}, "lists", "offset"),
    ("users", "GET", "/settings/v3/users", {"limit": 100}, "results", "after"),
    ("teams", "GET", "/settings/v3/users/teams", None, "results", None),
    ("workflows", "GET", "/automation/v4/flows", {"limit": 100}, "results", "after"),
    ("files_all", "GET", "/files/v3/files/search", {"limit": 100}, "results", "after"),
    ("conversation_inboxes", "GET", "/conversations/v3/conversations/inboxes", {"limit": 100}, "results", "after"),
    ("conversation_channels", "GET", "/conversations/v3/conversations/channels", {"limit": 100}, "results", "after"),
    ("conversation_channel_accounts", "GET", "/conversations/v3/conversations/channel-accounts", {"limit": 100}, "results", "after"),
]


class ApiError(Exception):
    def __init__(self, status, text, path):
        super().__init__("%s %s: %s" % (status, path, text))
        self.status, self.text, self.path = status, text, path


class Api:
    def __init__(self, token, delay=0.12):
        self.token, self.delay = token, delay

    def raw(self, method, path, body=None, params=None, absolute=False):
        url = path if absolute else BASE + path
        if params:
            url += "?" + urllib.parse.urlencode(params, doseq=True)
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if not absolute:
            headers["Authorization"] = "Bearer " + self.token
        for attempt in range(8):
            time.sleep(self.delay)
            req = urllib.request.Request(url, data=data, method=method, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    return r.read()
            except urllib.error.HTTPError as e:
                text = e.read().decode("utf-8", "replace")
                if e.code == 429 or e.code >= 500:
                    time.sleep(float(e.headers.get("Retry-After") or min(60, 2 ** attempt)))
                    continue
                raise ApiError(e.code, text[:400], path)
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                time.sleep(min(60, 2 ** attempt))
        raise ApiError(0, "retries exhausted", path)

    def call(self, method, path, body=None, params=None):
        raw = self.raw(method, path, body, params)
        return json.loads(raw) if raw else {}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def init_db(path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript("""
    CREATE TABLE IF NOT EXISTS objects(account TEXT, type TEXT, id TEXT, created TEXT, updated TEXT,
        archived INTEGER, props TEXT, PRIMARY KEY(account, type, id));
    CREATE TABLE IF NOT EXISTS associations(account TEXT, from_type TEXT, from_id TEXT, to_type TEXT,
        to_id TEXT, assoc_types TEXT, PRIMARY KEY(account, from_type, from_id, to_type, to_id));
    CREATE TABLE IF NOT EXISTS properties_meta(account TEXT, type TEXT, name TEXT, label TEXT,
        prop_type TEXT, field_type TEXT, group_name TEXT, options TEXT, calculated INTEGER,
        hubspot_defined INTEGER, read_only INTEGER, formula TEXT, description TEXT, definition TEXT,
        PRIMARY KEY(account, type, name));
    CREATE TABLE IF NOT EXISTS properties_usage(account TEXT, type TEXT, name TEXT, filled INTEGER,
        total INTEGER, PRIMARY KEY(account, type, name));
    CREATE VIEW IF NOT EXISTS v_campos_calculados AS SELECT m.account, m.type, m.name, m.label, m.formula,
        m.hubspot_defined, u.filled, u.total FROM properties_meta m LEFT JOIN properties_usage u
        ON u.account=m.account AND u.type=m.type AND u.name=m.name WHERE m.calculated=1;
    CREATE VIEW IF NOT EXISTS v_campos_personalizados AS SELECT m.account, m.type, m.name, m.label, m.prop_type,
        u.filled, u.total FROM properties_meta m LEFT JOIN properties_usage u
        ON u.account=m.account AND u.type=m.type AND u.name=m.name WHERE m.hubspot_defined=0;
    CREATE TABLE IF NOT EXISTS attachments(account TEXT, file_id TEXT, owner_type TEXT, owner_id TEXT,
        name TEXT, extension TEXT, size INTEGER, url TEXT, access TEXT, local_path TEXT, sha256 TEXT,
        status TEXT, note TEXT, PRIMARY KEY(account, file_id, owner_type, owner_id));
    CREATE TABLE IF NOT EXISTS misc(account TEXT, name TEXT, item_id TEXT, json TEXT,
        PRIMARY KEY(account, name, item_id));
    CREATE TABLE IF NOT EXISTS assoc_labels(account TEXT, from_type TEXT, to_type TEXT, type_id INTEGER,
        category TEXT, label TEXT, PRIMARY KEY(account, from_type, to_type, type_id, category));
    CREATE TABLE IF NOT EXISTS list_members(account TEXT, list_id TEXT, record_id TEXT, added_at TEXT,
        PRIMARY KEY(account, list_id, record_id));
    CREATE TABLE IF NOT EXISTS conversation_messages(account TEXT, thread_id TEXT, message_id TEXT, json TEXT,
        PRIMARY KEY(account, thread_id, message_id));
    CREATE TABLE IF NOT EXISTS export_log(account TEXT, step TEXT, status TEXT, fetched INTEGER,
        expected INTEGER, note TEXT, finished_at TEXT, PRIMARY KEY(account, step));
    CREATE INDEX IF NOT EXISTS idx_assoc_to ON associations(account, to_type, to_id);
    CREATE VIEW IF NOT EXISTS v_companies AS SELECT account, id, json_extract(props,'$.name') AS name,
        json_extract(props,'$.domain') AS domain, json_extract(props,'$.country') AS country,
        json_extract(props,'$.tipo_de_empresa') AS tipo_de_empresa,
        json_extract(props,'$.id_origen_cuenta_b') AS id_origen_cuenta_b, created, updated, props
        FROM objects WHERE type='companies';
    CREATE VIEW IF NOT EXISTS v_contacts AS SELECT account, id, json_extract(props,'$.email') AS email,
        json_extract(props,'$.firstname') AS firstname, json_extract(props,'$.lastname') AS lastname,
        json_extract(props,'$.id_contacto_origen_cuenta_b') AS id_contacto_origen_cuenta_b,
        created, updated, props FROM objects WHERE type='contacts';
    CREATE VIEW IF NOT EXISTS v_deals AS SELECT account, id, json_extract(props,'$.dealname') AS dealname,
        json_extract(props,'$.amount') AS amount, json_extract(props,'$.dealstage') AS dealstage,
        json_extract(props,'$.pipeline') AS pipeline, created, updated, props
        FROM objects WHERE type='deals';
    CREATE VIEW IF NOT EXISTS v_crosswalk AS SELECT a.id AS company_id_a, a.name AS name_a,
        b.id AS company_id_b, b.name AS name_b FROM v_companies a JOIN v_companies b
        ON b.account='B' AND b.id = a.id_origen_cuenta_b WHERE a.account='A';
    """)
    return db


def log(db, account, step, status, fetched=None, expected=None, note=None):
    db.execute("INSERT OR REPLACE INTO export_log VALUES(?,?,?,?,?,?,?)",
               (account, step, status, fetched, expected, (note or "")[:500], now()))
    db.commit()
    print("[%s] %-28s %-8s fetched=%s expected=%s %s" % (account, step, status, fetched, expected, note or ""),
          flush=True)


def done(db, account, step):
    r = db.execute("SELECT status FROM export_log WHERE account=? AND step=?", (account, step)).fetchone()
    return bool(r and r[0] == "done")


def export_type(api, db, account, otype, chunk, with_archived):
    step = "objects:" + otype
    try:
        meta = api.call("GET", "/crm/v3/properties/" + otype).get("results", [])
    except ApiError as e:
        log(db, account, step, "skipped", note="HTTP %s %s" % (e.status, re.sub(r"\s+", " ", e.text)[:160]))
        return
    for p in meta:
        db.execute("INSERT OR REPLACE INTO properties_meta VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                   (account, otype, p.get("name"), p.get("label"), p.get("type"), p.get("fieldType"),
                    p.get("groupName"), json.dumps(p.get("options") or [], ensure_ascii=False),
                    1 if p.get("calculated") else 0, 1 if p.get("hubspotDefined") else 0,
                    1 if p.get("readOnlyValue") else 0, p.get("calculationFormula"), p.get("description"),
                    json.dumps(p, ensure_ascii=False)))
    db.commit()
    names = [p["name"] for p in meta]
    expected = None
    try:
        expected = api.call("POST", "/crm/v3/objects/%s/search" % otype, {"limit": 1}).get("total")
    except ApiError:
        pass
    groups = [names[i:i + chunk] for i in range(0, len(names), chunk)] or [[]]
    try:
        for archived in ([False, True] if with_archived else [False]):
            for props in groups:
                after = None
                while True:
                    params = {"limit": 100, "archived": "true" if archived else "false"}
                    if props:
                        params["properties"] = ",".join(props)
                    if after:
                        params["after"] = after
                    page = api.call("GET", "/crm/v3/objects/" + otype, params=params)
                    for r in page.get("results", []):
                        slim = {k: v for k, v in (r.get("properties") or {}).items() if v not in (None, "")}
                        db.execute(
                            "INSERT INTO objects VALUES(?,?,?,?,?,?,?) ON CONFLICT(account,type,id) DO UPDATE SET "
                            "props=json_patch(objects.props, excluded.props), updated=excluded.updated, "
                            "archived=MIN(objects.archived, excluded.archived)",
                            (account, otype, str(r["id"]), r.get("createdAt"), r.get("updatedAt"),
                             1 if archived else 0, json.dumps(slim, ensure_ascii=False)))
                    db.commit()
                    after = (page.get("paging") or {}).get("next", {}).get("after")
                    if not after:
                        break
    except ApiError as e:
        log(db, account, step, "error", note="HTTP %s %s" % (e.status, re.sub(r"\s+", " ", e.text)[:160]))
        return
    n = db.execute("SELECT COUNT(*) FROM objects WHERE account=? AND type=? AND archived=0", (account, otype)).fetchone()[0]
    note = "" if expected is None or expected == n else "MISMATCH vs search total"
    log(db, account, step, "done", n, expected, note)


def export_associations(api, db, account):
    for f, t in ASSOC_PAIRS:
        step = "assoc:%s>%s" % (f, t)
        if done(db, account, step):
            continue
        ids = [r[0] for r in db.execute("SELECT id FROM objects WHERE account=? AND type=?", (account, f))]
        if not ids:
            continue
        total = 0
        try:
            for i in range(0, len(ids), 1000):
                res = api.call("POST", "/crm/v4/associations/%s/%s/batch/read" % (f, t),
                               {"inputs": [{"id": x} for x in ids[i:i + 1000]]})
                for r in res.get("results", []):
                    for to in r.get("to", []):
                        # from.id arrives as a string, toObjectId as a number: normalise both.
                        db.execute("INSERT OR REPLACE INTO associations VALUES(?,?,?,?,?,?)",
                                   (account, f, str(r["from"]["id"]), t, str(to["toObjectId"]),
                                    json.dumps(to.get("associationTypes") or [])))
                        total += 1
                db.commit()
        except ApiError as e:
            log(db, account, step, "skipped", note="HTTP %s %s" % (e.status, re.sub(r"\s+", " ", e.text)[:120]))
            continue
        log(db, account, step, "done", total)


def export_misc(api, db, account, only=None):
    for name, method, path, params, key, paging in MISC:
        if only and name not in only:
            continue
        step = "misc:" + name
        if done(db, account, step):
            continue
        n = 0
        try:
            cursor = None
            while True:
                p = dict(params or {})
                body = None
                if paging == "after" and cursor:
                    p["after"] = cursor
                if method == "POST":
                    body = dict(p)
                    if paging == "offset" and cursor:
                        body["offset"] = cursor
                    p = None
                res = api.call(method, path, body=body, params=p if method == "GET" else None)
                items = res.get(key, res if isinstance(res, list) else [])
                for it in items:
                    iid = str(it.get("id") or it.get("listId") or n)
                    db.execute("INSERT OR REPLACE INTO misc VALUES(?,?,?,?)",
                               (account, name, iid, json.dumps(it, ensure_ascii=False)))
                    n += 1
                db.commit()
                if paging == "after":
                    cursor = (res.get("paging") or {}).get("next", {}).get("after")
                elif paging == "offset":
                    cursor = res.get("offset") if res.get("hasMore") else None
                else:
                    cursor = None
                if not cursor:
                    break
        except ApiError as e:
            log(db, account, step, "skipped", note="HTTP %s %s" % (e.status, re.sub(r"\s+", " ", e.text)[:120]))
            continue
        log(db, account, step, "done", n)


def safe(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name or "file")[:120]



def paged(api, path, params, key="results"):
    """Yield every item of a cursor-paginated GET (paging.next.after)."""
    after = None
    while True:
        p = dict(params)
        if after:
            p["after"] = after
        page = api.call("GET", path, params=p)
        for it in page.get(key, []):
            yield it
        after = (page.get("paging") or {}).get("next", {}).get("after")
        if not after:
            return


def export_assoc_labels(api, db, account):
    step = "assoc-labels"
    if done(db, account, step):
        return
    n = 0
    for f, t in ASSOC_PAIRS:
        try:
            res = api.call("GET", "/crm/v4/associations/%s/%s/labels" % (f, t)).get("results", [])
        except ApiError:
            continue
        for r in res:
            db.execute("INSERT OR REPLACE INTO assoc_labels VALUES(?,?,?,?,?,?)",
                       (account, f, t, r.get("typeId"), r.get("category"), r.get("label")))
            n += 1
    db.commit()
    log(db, account, step, "done", n)


def export_list_members(api, db, account):
    step = "list-members"
    if done(db, account, step):
        return
    lists = [json.loads(j) for (j,) in db.execute("SELECT json FROM misc WHERE account=? AND name='lists'", (account,))]
    if not lists:
        return
    n = 0
    try:
        for lst in lists:
            lid = str(lst.get("listId") or lst.get("id"))
            for m in paged(api, "/crm/v3/lists/%s/memberships" % lid, {"limit": 250}):
                db.execute("INSERT OR REPLACE INTO list_members VALUES(?,?,?,?)",
                           (account, lid, str(m.get("recordId")), m.get("membershipTimestamp")))
                n += 1
            db.commit()
    except ApiError as e:
        log(db, account, step, "error", n, note="HTTP %s %s" % (e.status, re.sub(r"\s+", " ", e.text)[:120]))
        return
    log(db, account, step, "done", n, note="%d lists" % len(lists))


def export_custom_objects(api, db, account, chunk, with_archived):
    for (j,) in db.execute("SELECT json FROM misc WHERE account=? AND name='schemas_custom_objects'", (account,)).fetchall():
        sch = json.loads(j)
        tid = sch.get("objectTypeId")
        if tid and not done(db, account, "objects:" + tid):
            export_type(api, db, account, tid, chunk, with_archived)


def export_conversations(api, db, account):
    step = "conversations"
    if done(db, account, step):
        return
    threads = msgs = 0
    try:
        for archived in ("false", "true"):
            for th in paged(api, "/conversations/v3/conversations/threads", {"limit": 100, "archived": archived}):
                tid = str(th["id"])
                db.execute("INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?,?,?)",
                           (account, "conversation_threads", tid, th.get("createdAt"), th.get("latestMessageTimestamp"),
                            1 if archived == "true" else 0,
                            json.dumps({k: v for k, v in th.items() if v not in (None, "")}, ensure_ascii=False)))
                threads += 1
                for m in paged(api, "/conversations/v3/conversations/threads/%s/messages" % tid, {"limit": 100}):
                    db.execute("INSERT OR REPLACE INTO conversation_messages VALUES(?,?,?,?)",
                               (account, tid, str(m.get("id")), json.dumps(m, ensure_ascii=False)))
                    msgs += 1
                if threads % 50 == 0:
                    db.commit()
            db.commit()
    except ApiError as e:
        log(db, account, step, "skipped", threads, note="HTTP %s %s" % (e.status, re.sub(r"\s+", " ", e.text)[:120]))
        return
    log(db, account, step, "done", threads, note="%d messages" % msgs)


def fetch_file(api, db, account, f, path):
    """Download one HubSpot file (signed URL for private ones) and return its size."""
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, "rb") as fh:
            blob = fh.read()
        return len(blob), hashlib.sha256(blob).hexdigest()
    url = f.get("url")
    if str(f.get("access") or "").startswith("PRIVATE"):
        url = api.call("GET", "/files/v3/files/%s/signed-url" % f["id"]).get("url")
    blob = api.raw("GET", url, absolute=True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(blob)
    return len(blob), hashlib.sha256(blob).hexdigest()


def export_file_manager(api, db, account, outdir, mode, max_total_bytes):
    """Everything in the File Manager (template images, PDFs...) -- those HubSpot-hosted links die with the account."""
    step = "file-manager"
    if mode != "download" or done(db, account, step):
        return
    items = [json.loads(j) for (j,) in db.execute("SELECT json FROM misc WHERE account=? AND name='files_all'", (account,))]
    if not items:
        return
    already = db.execute("SELECT COALESCE(SUM(size),0) FROM attachments WHERE account=? AND status='downloaded'", (account,)).fetchone()[0]
    total = fetched = 0
    for f in items:
        fid = str(f["id"])
        if db.execute("SELECT 1 FROM attachments WHERE account=? AND file_id=? AND status='downloaded'", (account, fid)).fetchone():
            continue
        size = f.get("size") or 0
        if already + total + size > max_total_bytes:
            log(db, account, step, "stopped", fetched, note="max-total-gb cap reached")
            return
        parts = [safe(x) for x in (f.get("path") or "").strip("/").split("/") if x]
        name = safe("%s.%s" % (f.get("name"), f.get("extension")) if f.get("extension") and not str(f.get("name")).endswith("." + str(f.get("extension"))) else f.get("name"))
        path = os.path.join(outdir, account, "_gestor-archivos", *(parts[:-1] or []), "%s__%s" % (fid, parts[-1] if parts else name))
        try:
            n, sha = fetch_file(api, db, account, f, path)
            db.execute("INSERT OR REPLACE INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (account, fid, "file_manager", "", f.get("name"), f.get("extension"), n, f.get("url"),
                        f.get("access"), path, sha, "downloaded", ""))
            total += n
            fetched += 1
        except Exception as e:
            db.execute("INSERT OR REPLACE INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (account, fid, "file_manager", "", f.get("name"), f.get("extension"), size, f.get("url"),
                        f.get("access"), None, None, "error", str(e)[:200]))
        db.commit()
    log(db, account, step, "done", fetched, note="%.1f MB" % (total / 1e6))


def owner_label(db, account, otype, oid):
    """(folder, date, subject) so Drive stays browsable: account/company/date_subject__file."""
    row = db.execute("SELECT props FROM objects WHERE account=? AND type=? AND id=?", (account, otype, oid)).fetchone()
    props = json.loads(row[0]) if row else {}
    date = (props.get("hs_timestamp") or props.get("hs_createdate") or "")[:10] or "sin-fecha"
    subject = props.get("hs_email_subject") or props.get("hs_meeting_title") or props.get("hs_note_body", "")[:40] or otype
    folder = None
    for name_sql, args in (
        ("SELECT json_extract(c.props,'$.name') FROM associations a JOIN objects c ON c.account=a.account AND c.type='companies' AND c.id=a.to_id "
         "WHERE a.account=? AND a.from_type=? AND a.from_id=? AND a.to_type='companies' LIMIT 1", (account, otype, oid)),
        ("SELECT COALESCE(json_extract(c.props,'$.email'), json_extract(c.props,'$.lastname')) FROM associations a JOIN objects c "
         "ON c.account=a.account AND c.type='contacts' AND c.id=a.to_id WHERE a.account=? AND a.from_type=? AND a.from_id=? "
         "AND a.to_type='contacts' LIMIT 1", (account, otype, oid)),
    ):
        r = db.execute(name_sql, args).fetchone()
        if r and r[0]:
            folder = r[0]
            break
    return safe(folder or "sin-asociar")[:60], date, safe(re.sub(r"<[^>]+>", " ", subject))[:60]


def export_attachments(api, db, account, outdir, mode, max_total_bytes):
    """Files linked from engagements via hs_attachment_ids (emails, notes, meetings...)."""
    if mode == "none":
        return
    owners = {}
    for t in ENGAGEMENTS + ["deals", "tickets", "contacts", "companies"]:
        for oid, props in db.execute("SELECT id, props FROM objects WHERE account=? AND type=?", (account, t)):
            ids = (json.loads(props).get("hs_attachment_ids") or "")
            for fid in [x.strip() for x in str(ids).split(";") if x.strip()]:
                owners.setdefault(fid, []).append((t, oid))
    step = "attachments:meta"
    if not owners:
        log(db, account, step, "done", 0, note="no hs_attachment_ids found")
        return
    for fid, links in owners.items():
        have = db.execute("SELECT status FROM attachments WHERE account=? AND file_id=? LIMIT 1", (account, fid)).fetchone()
        if have:
            continue
        try:
            f = api.call("GET", "/files/v3/files/" + fid)
            status, note = "meta", ""
        except ApiError as e:
            f, status, note = {}, "error", "HTTP %s" % e.status
        for t, oid in links:
            db.execute("INSERT OR REPLACE INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (account, fid, t, oid, f.get("name"), f.get("extension"), f.get("size"), f.get("url"),
                        f.get("access"), None, None, status, note))
    db.commit()
    total = db.execute("SELECT COALESCE(SUM(size),0), COUNT(DISTINCT file_id) FROM attachments WHERE account=? AND status='meta'", (account,)).fetchone()
    log(db, account, step, "done", len(owners), note="%d files, %.1f MB to download" % (total[1], total[0] / 1e6))
    if mode != "download":
        return
    downloaded = 0
    seen = set()
    for fid, name, ext, size, url, access in db.execute(
            "SELECT file_id, name, extension, size, url, access FROM attachments WHERE account=? AND status='meta' GROUP BY file_id", (account,)).fetchall():
        if fid in seen:
            continue
        seen.add(fid)
        if downloaded + (size or 0) > max_total_bytes:
            log(db, account, "attachments:download", "stopped", note="max-total-gb cap reached")
            return
        otype_o, oid_o = db.execute(
            "SELECT owner_type, owner_id FROM attachments WHERE account=? AND file_id=? LIMIT 1", (account, fid)).fetchone()
        folder, date, subject = owner_label(db, account, otype_o, oid_o)
        target_dir = os.path.join(outdir, account, folder)
        os.makedirs(target_dir, exist_ok=True)
        base = safe(name if not ext or str(name).endswith("." + ext) else "%s.%s" % (name, ext))
        path = os.path.join(target_dir, "%s_%s__%s_%s" % (date, subject, fid, base))
        try:
            n, sha = fetch_file(api, db, account, {"id": fid, "url": url, "access": access}, path)
            downloaded += n
            db.execute("UPDATE attachments SET local_path=?, sha256=?, status='downloaded' WHERE account=? AND file_id=?",
                       (path, sha, account, fid))
        except Exception as e:  # keep going: one broken file must not stop the export
            db.execute("UPDATE attachments SET status='error', note=? WHERE account=? AND file_id=?",
                       (str(e)[:200], account, fid))
        db.commit()
    log(db, account, "attachments:download", "done", len(seen), note="%.1f MB" % (downloaded / 1e6))


def property_usage(db, account):
    """How many records actually have each property filled, and any value whose property has no definition."""
    db.execute("DELETE FROM properties_usage WHERE account=?", (account,))
    db.execute("""INSERT INTO properties_usage SELECT o.account, o.type, j.key, COUNT(*),
        (SELECT COUNT(*) FROM objects t WHERE t.account=o.account AND t.type=o.type AND t.archived=0)
        FROM objects o, json_each(o.props) j WHERE o.account=? AND o.archived=0 GROUP BY o.type, j.key""", (account,))
    db.commit()
    print("\n[%s] CAMPOS POR OBJETO (definidos / calculados / personalizados / con algún dato)" % account)
    for t, n, c, cu, f in db.execute("""SELECT m.type, COUNT(*), SUM(m.calculated), SUM(1-m.hubspot_defined),
            SUM(CASE WHEN u.filled>0 THEN 1 ELSE 0 END) FROM properties_meta m LEFT JOIN properties_usage u
            ON u.account=m.account AND u.type=m.type AND u.name=m.name WHERE m.account=? GROUP BY m.type""", (account,)):
        print("   %-22s %4d / %4d / %4d / %4d" % (t, n, c or 0, cu or 0, f or 0))
    orphan = db.execute("""SELECT u.type, u.name FROM properties_usage u LEFT JOIN properties_meta m
        ON m.account=u.account AND m.type=u.type AND m.name=u.name WHERE u.account=? AND m.name IS NULL""", (account,)).fetchall()
    if orphan:
        print("   AVISO: valores sin definicion de campo:", orphan[:10])


def load_env(path):
    if path and os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            m = re.match(r"\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$", line)
            if m and m.group(1) not in os.environ:
                os.environ[m.group(1)] = m.group(2).strip().strip('"').strip("'")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    repo = os.path.dirname(here)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", default=os.path.join(repo, ".env"))
    ap.add_argument("--db", default=os.path.join(os.path.dirname(repo), "base-de-datos", "hubspot_completo.sqlite"))
    ap.add_argument("--drive-dir", default=DEFAULT_DRIVE_DIR,
                    help="Shared Drive folder: attachments go to <dir>/adjuntos and a DB snapshot to <dir>/base-de-datos")
    ap.add_argument("--attachments-dir", default=None)
    ap.add_argument("--accounts", default="A,B")
    ap.add_argument("--only", default="", help="comma list of object types")
    ap.add_argument("--chunk", type=int, default=50, help="properties per request")
    ap.add_argument("--attachments", choices=["none", "meta", "download"], default="download")
    ap.add_argument("--max-total-gb", type=float, default=20.0)
    ap.add_argument("--skip-assoc", action="store_true")
    ap.add_argument("--only-files", action="store_true", help="only list + download the whole File Manager (safe to run in parallel with a separate --db)")
    ap.add_argument("--no-archived", action="store_true")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    load_env(args.env)
    db = init_db(args.db)
    drive_ok = bool(args.drive_dir) and os.path.isdir(args.drive_dir)
    if args.attachments != "none" and not args.attachments_dir and not drive_ok:
        print("AVISO: no encuentro la carpeta de Drive (%s); los adjuntos irán junto a la base local." % args.drive_dir)
    outdir = args.attachments_dir or (os.path.join(args.drive_dir, "adjuntos") if drive_ok
                                      else os.path.join(os.path.dirname(os.path.abspath(args.db)), "adjuntos"))
    types = [t for t in args.only.split(",") if t] or OBJECT_TYPES
    ran = 0
    for account in [a.strip().upper() for a in args.accounts.split(",")]:
        token = os.environ.get(ACCOUNT_ENV.get(account, ""), "")
        if not token:
            print("[%s] falta la variable %s -- cuenta omitida" % (account, ACCOUNT_ENV.get(account)))
            continue
        ran += 1
        api = Api(token)
        if args.force:
            db.execute("DELETE FROM export_log WHERE account=?", (account,))
        if args.only_files:
            export_misc(api, db, account, {"files_all"})
            export_file_manager(api, db, account, outdir, "download", int(args.max_total_gb * 1e9))
            continue
        for otype in types:
            if not done(db, account, "objects:" + otype):
                export_type(api, db, account, otype, args.chunk, not args.no_archived)
        if not args.skip_assoc:
            export_assoc_labels(api, db, account)
            export_associations(api, db, account)
        export_misc(api, db, account)
        export_custom_objects(api, db, account, args.chunk, not args.no_archived)
        export_list_members(api, db, account)
        export_conversations(api, db, account)
        export_attachments(api, db, account, outdir, args.attachments, int(args.max_total_gb * 1e9))
        export_file_manager(api, db, account, outdir, args.attachments, int(args.max_total_gb * 1e9))
        property_usage(db, account)
    if not ran:
        sys.exit("Ninguna cuenta con token. Crea %s con HUBSPOT_TOKEN y HUBSPOT_TOKEN_B." % args.env)
    print("\nRESUMEN")
    for row in db.execute("SELECT account, step, status, fetched, expected, note FROM export_log ORDER BY account, step"):
        print("  %s %-30s %-8s %6s / %-6s %s" % row)
    print("\nBase de datos:", os.path.abspath(args.db))
    if drive_ok:
        # The live DB stays local (Drive sync can corrupt an open SQLite); a consistent copy goes to Drive.
        snap_dir = os.path.join(args.drive_dir, "base-de-datos")
        os.makedirs(snap_dir, exist_ok=True)
        snap = os.path.join(snap_dir, "%s_%s.sqlite" % (os.path.splitext(os.path.basename(args.db))[0], datetime.now().strftime("%Y-%m-%d")))
        dest = sqlite3.connect(snap)
        db.backup(dest)
        dest.close()
        print("Copia en Drive:", snap)


if __name__ == "__main__":
    main()
