const path = require('path');
const Database = require('better-sqlite3');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', process.env.NODE_ENV === 'test' ? 'test.sqlite' : 'app.sqlite');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS styles (
    id INTEGER PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY,
    style_id INTEGER NOT NULL REFERENCES styles(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    cover_photo_id INTEGER,
    published_version INTEGER NOT NULL DEFAULT 1,
    working_version INTEGER NOT NULL DEFAULT 1,
    is_public INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    title TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    working_public_license INTEGER NOT NULL DEFAULT 1,
    published_public_license INTEGER NOT NULL DEFAULT 1,
    published_version INTEGER NOT NULL DEFAULT 1,
    license_updated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS packages (
    id INTEGER PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    travel_before_minutes INTEGER NOT NULL DEFAULT 30,
    setup_minutes INTEGER NOT NULL DEFAULT 20,
    teardown_minutes INTEGER NOT NULL DEFAULT 20,
    travel_after_minutes INTEGER NOT NULL DEFAULT 30,
    included_scope TEXT NOT NULL DEFAULT '[]',
    is_active INTEGER NOT NULL DEFAULT 1,
    current_price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CNY',
    version INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('photographer','assistant','equipment','location')),
    name TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS package_resources (
    package_id INTEGER NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    resource_id INTEGER NOT NULL REFERENCES resources(id),
    role TEXT NOT NULL DEFAULT 'required',
    PRIMARY KEY(package_id, resource_id)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY,
    public_ref TEXT UNIQUE NOT NULL,
    idempotency_key TEXT UNIQUE,
    package_id INTEGER NOT NULL REFERENCES packages(id),
    package_snapshot TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_contact TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','held','queued','confirmed','cancelled','completed')),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    timezone TEXT NOT NULL,
    locked_at TEXT,
    hold_expires_at TEXT,
    confirmed_at TEXT,
    cancelled_at TEXT,
    queue_position INTEGER,
    price_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'CNY',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS booking_resources (
    booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    resource_id INTEGER NOT NULL REFERENCES resources(id),
    phase_type TEXT NOT NULL CHECK(phase_type IN ('travel_before','setup','shoot','teardown','travel_after')),
    phase_label TEXT NOT NULL,
    phase_start TEXT NOT NULL,
    phase_end TEXT NOT NULL,
    PRIMARY KEY(booking_id, resource_id, phase_type)
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY,
    resource_id INTEGER NOT NULL REFERENCES resources(id),
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY,
    booking_id INTEGER,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT 'system',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_albums_style ON albums(style_id);
  CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_bookings_status_time ON bookings(status, start_at);
  CREATE INDEX IF NOT EXISTS idx_booking_resources_time ON booking_resources(phase_start, phase_end);
  `);

  const photoColumns = db.prepare("PRAGMA table_info(photos)").all().map(c => c.name);
  if (!photoColumns.includes('published_public_license')) {
    db.exec('ALTER TABLE photos ADD COLUMN published_public_license INTEGER NOT NULL DEFAULT 1');
  }
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM styles').get().n;
  if (count > 0) return;
  const tx = db.transaction(() => {
    const insertStyle = db.prepare('INSERT INTO styles(slug,name,description,sort_order) VALUES(?,?,?,?)');
    const wedding = insertStyle.run('wedding','婚礼','自然光、仪式细节与双人肖像',10).lastInsertRowid;
    const portrait = insertStyle.run('portrait','肖像','棚拍与城市环境中的个人表达',20).lastInsertRowid;
    const travel = insertStyle.run('travel','旅行','城市与自然旅途中的纪实画面',30).lastInsertRowid;

    const insertAlbum = db.prepare(`INSERT INTO albums(style_id,title,description,cover_photo_id,published_version,working_version,is_public)
      VALUES(?,?,?,?,1,1,1)`);
    const insertPhoto = db.prepare(`INSERT INTO photos(album_id,url,title,sort_order,working_public_license,published_public_license,published_version,license_updated_at)
      VALUES(?,?,?,?,1,1,1,datetime('now'))`);
    const albumData = [
      [wedding, '海湾婚礼', '仪式、海风与金色时刻。', [
        ['/images/wedding-1.svg','誓言前的光'], ['/images/wedding-2.svg','牵手入场'], ['/images/wedding-3.svg','戒指与花'],
        ['/images/wedding-4.svg','宾客合影'], ['/images/wedding-5.svg','黄昏双人照']
      ]],
      [portrait, '城市肖像', '简洁背景与街头光影。', [
        ['/images/portrait-1.svg','窗边肖像'], ['/images/portrait-2.svg','黑白轮廓'], ['/images/portrait-3.svg','街角自然光']
      ]],
      [travel, '山间旅拍', '徒步、云雾和开阔风景。', [
        ['/images/travel-1.svg','清晨山路'], ['/images/travel-2.svg','云雾远景'], ['/images/travel-3.svg','营地肖像']
      ]]
    ];
    for (const [styleId,title,desc,photos] of albumData) {
      const aid = insertAlbum.run(styleId,title,desc,null).lastInsertRowid;
      photos.forEach((p, i) => insertPhoto.run(aid,p[0],p[1],i));
      const cover = db.prepare('SELECT id FROM photos WHERE album_id=? ORDER BY sort_order LIMIT 1').get(aid);
      db.prepare('UPDATE albums SET cover_photo_id=? WHERE id=?').run(cover.id, aid);
    }

    const insertPackage = db.prepare(`INSERT INTO packages
      (slug,name,description,duration_minutes,travel_before_minutes,setup_minutes,teardown_minutes,travel_after_minutes,included_scope,current_price_cents,currency,version)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1)`);
    const p1 = insertPackage.run('portrait-90','90分钟肖像','适合个人形象照、情侣肖像与轻量家庭拍摄。',
      90,30,20,15,30, JSON.stringify(['1名摄影师','基础灯光','20张精修','在线画廊']), 129000,'CNY').lastInsertRowid;
    const p2 = insertPackage.run('wedding-halfday','半日婚礼记录','覆盖准备、仪式与合影，安排助手和双机位。',
      240,60,45,30,45, JSON.stringify(['1名摄影师','1名助手','双机位','灯光套装','60张精修','在线画廊']), 599000,'CNY').lastInsertRowid;
    const p3 = insertPackage.run('travel-full-day','全天旅拍','边走边拍，包含交通与多地点布置。',
      480,90,45,30,90, JSON.stringify(['1名摄影师','1名助手','便携灯光','两地点交通','100张精修','在线画廊']), 999000,'CNY').lastInsertRowid;

    const insertResource = db.prepare('INSERT INTO resources(type,name,is_active) VALUES(?,?,1)');
    const r = {};
    [['photographer','林摄影师'],['photographer','周摄影师'],['assistant','助手阿明'],['assistant','助手小禾'],
     ['equipment','主力相机A7'],['equipment','双机位镜头组'],['equipment','便携灯光套装'],['equipment','外拍反光板'],
     ['location','一号棚'],['location','海湾草坪']].forEach(([type,name]) => {
      r[name] = insertResource.run(type,name).lastInsertRowid;
    });
    const link = db.prepare('INSERT INTO package_resources(package_id,resource_id,role) VALUES(?,?,?)');
    [[p1,r['林摄影师']],[p1,r['主力相机A7']],[p1,r['便携灯光套装']]
    ,[p2,r['林摄影师']],[p2,r['助手阿明']],[p2,r['主力相机A7']],[p2,r['双机位镜头组']],[p2,r['便携灯光套装']]
    ,[p3,r['林摄影师']],[p3,r['助手小禾']],[p3,r['双机位镜头组']],[p3,r['便携灯光套装']],[p3,r['外拍反光板']]
    ].forEach(([pkg,res]) => link.run(pkg,res,'required'));
  });
  tx();
}

migrate();
seed();

module.exports = db;
