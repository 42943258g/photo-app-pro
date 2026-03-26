require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs'); // 追加：ファイルがあるか確認する道具

// Google Cloud Storage の設定（本番とローカルを自動判定！）
const storageOptions = fs.existsSync('gcp-key.json') ? { keyFilename: 'gcp-key.json' } : {};
const storage = new Storage(storageOptions);

const multer = require('multer');
const upload = multer(); // フォームデータを解読するツール

const app = express();
const port = process.env.PORT || 3000;

// Google Cloud Storage の設定
const bucketName = 'photo-app-storage-jo'; // ★先ほど作ったバケット名
const bucket = storage.bucket(bucketName);

// データベースの設定
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- データベースの再構築（プロ仕様） ---
const updateDbQuery = `
    -- 1. ルーム管理テーブル
    CREATE TABLE IF NOT EXISTS rooms (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        login_id VARCHAR(50) UNIQUE NOT NULL,
        login_pass VARCHAR(50) NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. アップ場所（カテゴリ）テーブル
    CREATE TABLE IF NOT EXISTS locations (
        id SERIAL PRIMARY KEY,
        room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. 写真保存テーブル（Storageのファイル名を保存）
    CREATE TABLE IF NOT EXISTS photos (
        id SERIAL PRIMARY KEY,
        location_id INTEGER REFERENCES locations(id) ON DELETE CASCADE,
        image_filename TEXT NOT NULL, -- 画像データではなくファイル名
        title VARCHAR(255),
        uploaded_by VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    -- 4. ログインログ テーブル
    CREATE TABLE IF NOT EXISTS login_logs (
        id SERIAL PRIMARY KEY,
        room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
        ip_address VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
`;
pool.query(updateDbQuery)
    .then(() => console.log('✅ 新しいデータベース構造(GCS対応)の準備完了！'))
    .catch(err => console.error('テーブル作成エラー:', err));


// --- ランダムな文字列を作る関数 ---
function generateRandomString(length) {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}

// ==========================================
// 管理者用 API
// ==========================================

// ルームを作成
app.post('/api/admin/rooms', async (req, res) => {
    const roomName = req.body.roomName;
    if (!roomName) return res.status(400).send('ルーム名が必要です');

    const loginId = generateRandomString(6);
    const loginPass = generateRandomString(8);

    try {
        const query = 'INSERT INTO rooms (name, login_id, login_pass) VALUES ($1, $2, $3) RETURNING *';
        const result = await pool.query(query, [roomName, loginId, loginPass]);
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).send('ルームの作成に失敗しました');
    }
});

// ルーム一覧とアップ場所（写真枚数付き）を取得
app.get('/api/admin/rooms', async (req, res) => {
    try {
        const roomsResult = await pool.query('SELECT * FROM rooms ORDER BY id ASC');
        const locationsResult = await pool.query(`
            SELECT l.*, COUNT(p.id) as photo_count 
            FROM locations l 
            LEFT JOIN photos p ON l.id = p.location_id 
            GROUP BY l.id ORDER BY l.id ASC
        `);
        const rooms = roomsResult.rows.map(room => {
            room.locations = locationsResult.rows.filter(loc => loc.room_id === room.id);
            return room;
        });
        res.json(rooms);
    } catch (err) {
        res.status(500).send('取得失敗');
    }
});

// 場所の名前を変更（保存）
app.put('/api/admin/locations/:id', async (req, res) => {
    try {
        await pool.query('UPDATE locations SET name = $1 WHERE id = $2', [req.body.name, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('更新に失敗しました');
    }
});

// 場所を削除
app.delete('/api/admin/locations/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM locations WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('削除に失敗しました');
    }
});

// フォルダ一覧を「シートの通りに」完全同期
app.put('/api/admin/locations/sync/:roomId', async (req, res) => {
    const roomId = req.params.roomId;
    const locations = req.body.locations;

    try {
        const currentRes = await pool.query('SELECT id FROM locations WHERE room_id = $1', [roomId]);
        const currentIds = currentRes.rows.map(r => r.id);
        const incomingIds = locations.map(l => l.id).filter(id => id !== null);

        const toDelete = currentIds.filter(id => !incomingIds.includes(id));
        for (const id of toDelete) {
            const pRes = await pool.query('SELECT count(*) FROM photos WHERE location_id = $1', [id]);
            if (parseInt(pRes.rows[0].count) === 0) {
                await pool.query('DELETE FROM locations WHERE id = $1', [id]);
            }
        }

        for (const loc of locations) {
            if (!loc.name.trim()) continue;
            if (loc.id) {
                await pool.query('UPDATE locations SET name = $1 WHERE id = $2', [loc.name.trim(), loc.id]);
            } else {
                await pool.query('INSERT INTO locations (room_id, name) VALUES ($1, $2)', [roomId, loc.name.trim()]);
            }
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('シートの保存に失敗しました');
    }
});

// ルームを丸ごと削除する
app.delete('/api/admin/rooms/:id', async (req, res) => {
    try {
        await pool.query('DELETE FROM rooms WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('ルーム削除に失敗');
    }
});

// ルーム名を変更する
app.put('/api/admin/rooms/:id', async (req, res) => {
    try {
        await pool.query('UPDATE rooms SET name = $1 WHERE id = $2', [req.body.name, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('更新失敗');
    }
});

// IDとパスワードを再発行
app.put('/api/admin/rooms/:id/credentials', async (req, res) => {
    const newId = Math.random().toString(36).substring(2, 8);
    const newPass = Math.random().toString(36).substring(2, 10);
    try {
        await pool.query('UPDATE rooms SET login_id = $1, login_pass = $2 WHERE id = $3', [newId, newPass, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('再発行失敗');
    }
});

// ルームの停止・再開を切り替え
app.put('/api/admin/rooms/:id/toggle-active', async (req, res) => {
    try {
        await pool.query('UPDATE rooms SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('切替失敗');
    }
});

// ログインログを取得
app.get('/api/admin/rooms/:id/logs', async (req, res) => {
    try {
        const result = await pool.query('SELECT ip_address, created_at FROM login_logs WHERE room_id = $1 ORDER BY created_at DESC LIMIT 50', [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('ログ取得失敗');
    }
});

// ルーム内の全写真をZIPで一括ダウンロード (GCS対応版)
app.get('/api/admin/rooms/:roomId/download', async (req, res) => {
    try {
        const query = `
            SELECT p.image_filename, p.title, p.id, l.name as loc_name
            FROM photos p
            JOIN locations l ON p.location_id = l.id
            WHERE l.room_id = $1
        `;
        const result = await pool.query(query, [req.params.roomId]);
        if (result.rows.length === 0) return res.status(404).send('写真がありません');

        res.attachment(`room_${req.params.roomId}_photos.zip`);
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);

        for (const photo of result.rows) {
            const file = bucket.file(photo.image_filename);
            const [buffer] = await file.download(); // GCSから画像をダウンロードしてZIPに詰める
            
            const filename = `${photo.loc_name}/${photo.title || '無題'}_${photo.id}.jpg`;
            archive.append(buffer, { name: filename });
        }
        
        archive.finalize();
    } catch (err) {
        console.error('ZIP作成エラー:', err);
        res.status(500).send('ZIP作成失敗');
    }
});


// ==========================================
// 一般ユーザー用 API
// ==========================================

// ログイン処理
app.post('/api/login', async (req, res) => {
    const { loginId, loginPass } = req.body;
    if (loginId === 'admin' && loginPass === 'admin123') return res.json({ success: true, isAdmin: true });
    
    try {
        const result = await pool.query('SELECT * FROM rooms WHERE login_id = $1 AND login_pass = $2', [loginId, loginPass]);
        if (result.rows.length > 0) {
            const room = result.rows[0];
            if (!room.is_active) {
                return res.status(403).json({ success: false, message: 'このルームは現在利用停止されています' });
            }

            const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '不明';
            await pool.query('INSERT INTO login_logs (room_id, ip_address) VALUES ($1, $2)', [room.id, ip]);

            res.json({ success: true, isAdmin: false, room: room });
        } else {
            res.status(401).json({ success: false, message: 'IDまたはパスワードが違います' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'サーバーエラー' });
    }
});

// --- API: 現場画面用 そのルームの全写真を一気に取得 (GCS対応版) ---
app.get('/api/photos/room/:roomId', async (req, res) => {
    try {
        const query = `
            SELECT p.id, p.location_id, p.title, p.uploaded_by, p.created_at, p.image_filename
            FROM photos p
            JOIN locations l ON p.location_id = l.id
            WHERE l.room_id = $1
            ORDER BY p.created_at DESC
        `;
        const result = await pool.query(query, [req.params.roomId]);
        
        // それぞれの写真に1時間限定の魔法のURLを発行
        const photos = await Promise.all(result.rows.map(async (row) => {
            let url = null;
            if (row.image_filename) {
                const file = bucket.file(row.image_filename);
                [url] = await file.getSignedUrl({
                    version: 'v4',
                    action: 'read',
                    expires: Date.now() + 60 * 60 * 1000,
                });
            }
            return {
                id: row.id,
                location_id: row.location_id,
                title: row.title,
                uploaded_by: row.uploaded_by,
                created_at: row.created_at,
                image_data: url
            };
        }));

        res.json(photos);
    } catch (err) {
        console.error('ルーム内写真取得エラー:', err);
        res.status(500).send('写真の取得に失敗しました');
    }
});

// 場所一覧を取得 (写真枚数付き)
app.get('/api/locations/:roomId', async (req, res) => {
    try {
        const query = `
            SELECT l.id, l.name, COUNT(p.id) as photo_count 
            FROM locations l 
            LEFT JOIN photos p ON l.id = p.location_id 
            WHERE l.room_id = $1 
            GROUP BY l.id 
            ORDER BY l.id ASC
        `;
        const result = await pool.query(query, [req.params.roomId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).send('場所の取得に失敗');
    }
});



// --- API: 写真をアップロード (最強フル対応版) ---
// ★ upload.any() に変更：ファイルでも文字でも何でも受け取る設定
app.post('/api/upload', upload.any(), async (req, res) => {
    try {
        const targetId = req.body.locationId || req.body.roomId;
        const memoTitle = req.body.title || req.body.comment || '無題';
        const uploadedBy = req.body.uploadedBy || 'ゲスト';

        let buffer;

        // パターンA: ちゃんと「ファイル」として画像が届いた場合
        if (req.files && req.files.length > 0) {
            buffer = req.files[0].buffer;
        } 
        // パターンB: 「Base64の長〜い文字」として画像が届いた場合
        else if (req.body.imageData) {
            const base64Data = req.body.imageData.replace(/^data:image\/\w+;base64,/, "");
            buffer = Buffer.from(base64Data, 'base64');
        } 
        // どちらも無い場合はエラーで弾く
        else {
            return res.status(400).json({ success: false, message: '画像データが見つかりません' });
        }

        // 世界で一つだけのファイル名を作成
        const filename = `${uuidv4()}.jpg`;
        const file = bucket.file(filename);

        // Google Cloud Storage に画像を保存！
        await file.save(buffer, { contentType: 'image/jpeg' });

        // データベースに記録を保存
        await pool.query(
            'INSERT INTO photos (location_id, image_filename, title, uploaded_by) VALUES ($1, $2, $3, $4)',
            [targetId, filename, memoTitle, uploadedBy]
        );

        res.json({ success: true });
    } catch (err) {
        console.error('アップロードエラー:', err);
        res.status(500).json({ success: false, message: '保存に失敗しました' });
    }
});

// --- API: 画像データ本体を取得して表示 (GCS対応・中継ぎ版) ---
app.get('/api/image/new/:id', async (req, res) => {
    try {
        // 1. データベースから「写真のファイル名」を探す
        const result = await pool.query('SELECT image_filename FROM photos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).send('写真が見つかりません');

        const filename = result.rows[0].image_filename;
        const file = bucket.file(filename);

        // 2. Google Cloudの倉庫から画像をダウンロードしながら、直接ブラウザに流し込む（ストリーム）
        res.setHeader('Content-Type', 'image/jpeg');
        file.createReadStream()
            .on('error', (err) => {
                console.error('画像読み込みエラー:', err);
                res.status(500).send('画像読み込みエラー');
            })
            .pipe(res);

    } catch (err) {
        console.error('画像検索エラー:', err);
        res.status(500).send('サーバーエラー');
    }
});


// 特定の「アップ場所」の写真リストを取得 (一時URLを発行)
app.get('/api/photos/:locationId', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM photos WHERE location_id = $1 ORDER BY created_at DESC', [req.params.locationId]);
        
        const photos = await Promise.all(result.rows.map(async (row) => {
            const file = bucket.file(row.image_filename);
            const [url] = await file.getSignedUrl({
                version: 'v4',
                action: 'read',
                expires: Date.now() + 60 * 60 * 1000, // 1時間限定の魔法のURL
            });
            
            return {
                id: row.id,
                title: row.title,
                uploaded_by: row.uploaded_by,
                created_at: row.created_at,
                image_data: url // スマホにはURLを渡す
            };
        }));

        res.json(photos);
    } catch (err) {
        console.error('写真取得エラー:', err);
        res.status(500).send('写真の取得に失敗しました');
    }
});

// 投稿済みの写真の「メモ（タイトル）」を変更する
app.put('/api/photos/:id/memo', async (req, res) => {
    try {
        await pool.query('UPDATE photos SET title = $1 WHERE id = $2', [req.body.title, req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).send('更新失敗');
    }
});

// 写真の削除機能 (GCSからも削除する)
app.delete('/api/photos/:id', async (req, res) => {
    try {
        // 1. データベースからファイル名を取得
        const result = await pool.query('SELECT image_filename FROM photos WHERE id = $1', [req.params.id]);
        if (result.rows.length > 0) {
            // 2. GCS(写真置き場)から実データを削除
            const filename = result.rows[0].image_filename;
            await bucket.file(filename).delete().catch(err => console.log('GCS削除スキップ(ファイルなし等)'));
        }
        
        // 3. データベースの記録を削除
        await pool.query('DELETE FROM photos WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        console.error('削除エラー:', err);
        res.status(500).json({ success: false, message: '削除に失敗しました' });
    }
});

app.listen(port, () => console.log(`サーバー起動: http://localhost:${port}`));