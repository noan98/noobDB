//! 空間データ (PostGIS の `geometry` / `geography`、MySQL の `GEOMETRY` 系) の
//! バイナリ表現を EWKT 文字列へ変換する純関数と、その文字列を SQL リテラルへ戻す関数 (#2379)。
//!
//! - PostgreSQL (PostGIS) のワイヤ表現は EWKB (`geometry_send` / `geography_send`)。バイナリ
//!   形式の結果は生の EWKB、テキスト形式 (simple query) の結果は EWKB の 16 進文字列で届く。
//! - MySQL の内部形式は「SRID 4 バイト (リトルエンディアン) + WKB」。
//! - SQLite は SpatiaLite を前提にしないので**対象外** (空間型を持たず、変換もしない)。
//!
//! 値は新しい `Value` の種別を作らず、`Value::String` に **EWKT** (`SRID=4326;POINT(139.76 35.68)`、
//! SRID が 0 のときは接頭辞なしの WKT) を入れて運ぶ。列が空間型かどうかは `Column.type_name`
//! (`geometry` / `geography` / `GEOMETRY`) で分かるので、書き戻しは型を見て
//! [`spatial_sql_literal`] (`ST_GeomFromText('…', srid)`) へ変換する。
//!
//! 読めないバイト列 (曲線型・壊れたデータ・未知のタイプ) は `None` を返し、呼び出し側が従来の
//! 16 進文字列表示へ戻す (壊さない)。
//!
//! 座標の並びはバイナリに入っているままの順序 (経度, 緯度。MySQL 8 の内部形式も同じ)。MySQL へ書き戻す
//! ときは `ST_GeomFromText` に `'axis-order=long-lat'` を付けて、この順序で読ませる。

use crate::db::DriverKind;

/// ジオメトリの入れ子の上限 (GeometryCollection の中の GeometryCollection …)。
const MAX_DEPTH: u32 = 8;

/// EWKB の SRID フラグ / Z フラグ / M フラグ (タイプ語の上位ビット)。
const FLAG_Z: u32 = 0x8000_0000;
const FLAG_M: u32 = 0x4000_0000;
const FLAG_SRID: u32 = 0x2000_0000;

/// 列の型名 (`Column.type_name`) が空間型か。PostGIS は `geometry` / `geography` (スキーマ修飾が付く
/// ことがある)、MySQL は sqlx が全空間型を `GEOMETRY` と報告する。
pub fn is_spatial_type_name(type_name: &str) -> bool {
    let base = type_name.split('(').next().unwrap_or(type_name).trim();
    let last = base.rsplit('.').next().unwrap_or(base).trim_matches('"');
    last.eq_ignore_ascii_case("geometry") || last.eq_ignore_ascii_case("geography")
}

/// MySQL が宣言する具体的な空間型名 (`information_schema.COLUMNS.COLUMN_TYPE` は `point` のように
/// 返す。sqlx のクエリ結果の列型は常に `GEOMETRY`)。`geomcollection` は 8.0 の別名。
const MYSQL_SPATIAL_TYPES: &[&str] = &[
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
    "geomcollection",
];

/// ドライバを考慮した空間型の判定。MySQL は具体的な型名 (`point` / `polygon` …) も空間型だが、
/// PostgreSQL の `point` / `polygon` は標準の幾何型 (PostGIS ではない) なので含めない。
/// SQLite は SpatiaLite を前提にしないので、`GEOMETRY` と宣言された列でも空間扱いしない。
pub fn is_spatial_column(driver: DriverKind, type_name: &str) -> bool {
    match driver {
        DriverKind::Sqlite => false,
        DriverKind::Postgres => is_spatial_type_name(type_name),
        DriverKind::Mysql => {
            let base = type_name.split('(').next().unwrap_or(type_name).trim();
            MYSQL_SPATIAL_TYPES
                .iter()
                .any(|t| base.eq_ignore_ascii_case(t))
        }
    }
}

/// PostGIS の EWKB (バイナリ形式のワイヤ値) を EWKT へ。
pub fn ewkb_to_ewkt(bytes: &[u8]) -> Option<String> {
    let mut r = Reader { b: bytes, pos: 0 };
    let (text, srid) = read_geometry(&mut r, 0, true)?;
    if r.pos != bytes.len() {
        return None;
    }
    Some(with_srid(srid.unwrap_or(0), &text))
}

/// PostGIS のテキスト形式の値 (EWKB の 16 進文字列) を EWKT へ。
pub fn ewkb_hex_to_ewkt(hex: &[u8]) -> Option<String> {
    let bin = data_encoding::HEXLOWER_PERMISSIVE.decode(hex).ok()?;
    ewkb_to_ewkt(&bin)
}

/// MySQL の内部形式 (SRID 4 バイト + WKB) を EWKT へ。
pub fn mysql_geometry_to_ewkt(bytes: &[u8]) -> Option<String> {
    let srid_bytes: [u8; 4] = bytes.get(..4)?.try_into().ok()?;
    let srid = u32::from_le_bytes(srid_bytes);
    let mut r = Reader { b: bytes, pos: 4 };
    let (text, _) = read_geometry(&mut r, 0, false)?;
    if r.pos != bytes.len() {
        return None;
    }
    Some(with_srid(srid, &text))
}

fn with_srid(srid: u32, wkt: &str) -> String {
    if srid == 0 {
        wkt.to_string()
    } else {
        format!("SRID={srid};{wkt}")
    }
}

/// `SRID=4326;POINT(1 2)` を `(Some(4326), "POINT(1 2)")` に分ける。接頭辞が無ければ SRID は `None`。
pub fn split_ewkt(s: &str) -> (Option<u32>, &str) {
    let t = s.trim_start();
    let Some(rest) = t.get(..5).filter(|p| p.eq_ignore_ascii_case("SRID=")) else {
        return (None, s.trim());
    };
    let _ = rest;
    let after = &t[5..];
    let Some((num, body)) = after.split_once(';') else {
        return (None, s.trim());
    };
    match num.trim().parse::<u32>() {
        Ok(n) => (Some(n), body.trim()),
        Err(_) => (None, s.trim()),
    }
}

/// WKT 本体に許す文字 (タグ・数値・括弧・カンマ・空白)。`quote_string` が引用符を二重化するので
/// 注入にはならないが、空間リテラルとして組み立てる前に念のため弾く。
fn is_wkt_charset(s: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b' ' | b'\t' | b'\n' | b'\r' | b'.' | b',' | b'(' | b')' | b'+' | b'-'
                )
        })
}

/// EWKT を書き戻し用の式 `ST_GeomFromText('<WKT>', <SRID>)` にする (PostgreSQL / MySQL 共通)。
/// SRID が無ければ第 2 引数を省く。MySQL で SRID が 0 以外のときは `'axis-order=long-lat'` を付ける:
/// MySQL 8 の内部形式は (地理座標系でも) 経度, 緯度の順で、表示もその順 (PostGIS と同じ)。オプション無しだと
/// 地理座標系 (4326 など) は緯度, 経度の順として読まれ、値が入れ替わる / ERROR 3617 になる。
/// 投影座標系や SRID 0 ではオプションは無視される。SQLite と、WKT として不正な文字を含む入力は `None`
/// (呼び出し側が通常の文字列リテラルへ戻す)。
pub fn spatial_sql_literal(driver: DriverKind, ewkt: &str) -> Option<String> {
    if driver == DriverKind::Sqlite {
        return None;
    }
    let (srid, wkt) = split_ewkt(ewkt);
    if !is_wkt_charset(wkt) {
        return None;
    }
    Some(match srid {
        Some(n) if n != 0 && driver == DriverKind::Mysql => {
            format!("ST_GeomFromText('{wkt}', {n}, 'axis-order=long-lat')")
        }
        Some(n) => format!("ST_GeomFromText('{wkt}', {n})"),
        None => format!("ST_GeomFromText('{wkt}')"),
    })
}

/// MySQL の一括取り込み (プレースホルダ bind) で、空間列の値を包む式。WKT と SRID の 2 つを bind する
/// (SRID は行ごとに違いうるので式へ埋め込まず bind にする)。SRID 0 では `'axis-order=long-lat'` は
/// 無視される。MySQL 8.0.12 未満と MariaDB は第 3 引数を受けない (対象外)。
pub const MYSQL_SPATIAL_PLACEHOLDER: &str = "ST_GeomFromText(?, ?, 'axis-order=long-lat')";

/// 取り込み (bind) で空間列のプレースホルダを `?` から別の式へ置き換えるか。MySQL は文字列 bind を
/// 空間型へ暗黙変換できず ERROR 1416 になるので式で包む。PostgreSQL は EWKT のテキストリテラルを
/// `geometry` / `geography` の入力関数がそのまま受けるので置き換えない (`None`)。SQLite は対象外。
pub fn spatial_import_placeholder(driver: DriverKind) -> Option<&'static str> {
    match driver {
        DriverKind::Mysql => Some(MYSQL_SPATIAL_PLACEHOLDER),
        DriverKind::Postgres | DriverKind::Sqlite => None,
    }
}

/// [`MYSQL_SPATIAL_PLACEHOLDER`] へ bind する (WKT, SRID)。EWKT 接頭辞が無ければ SRID は 0。
/// セルが NULL なら (None, 0) で、式全体が NULL になる。
pub fn mysql_spatial_binds(cell: Option<&str>) -> (Option<&str>, u32) {
    match cell {
        None => (None, 0),
        Some(s) => {
            let (srid, wkt) = split_ewkt(s);
            (Some(wkt), srid.unwrap_or(0))
        }
    }
}

struct Reader<'a> {
    b: &'a [u8],
    pos: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }

    fn u32(&mut self, le: bool) -> Option<u32> {
        let a: [u8; 4] = self.b.get(self.pos..self.pos + 4)?.try_into().ok()?;
        self.pos += 4;
        Some(if le {
            u32::from_le_bytes(a)
        } else {
            u32::from_be_bytes(a)
        })
    }

    fn f64(&mut self, le: bool) -> Option<f64> {
        let a: [u8; 8] = self.b.get(self.pos..self.pos + 8)?.try_into().ok()?;
        self.pos += 8;
        Some(if le {
            f64::from_le_bytes(a)
        } else {
            f64::from_be_bytes(a)
        })
    }

    fn remaining(&self) -> usize {
        self.b.len().saturating_sub(self.pos)
    }
}

/// 次元 (座標 1 点あたりの値の数 = 2 + Z + M)。
#[derive(Clone, Copy)]
struct Dim {
    z: bool,
    m: bool,
}

impl Dim {
    fn n(self) -> usize {
        2 + usize::from(self.z) + usize::from(self.m)
    }

    /// WKT のタグ後ろの次元指定 (`" Z"` / `" M"` / `" ZM"` / 空)。
    fn suffix(self) -> &'static str {
        match (self.z, self.m) {
            (false, false) => "",
            (true, false) => " Z",
            (false, true) => " M",
            (true, true) => " ZM",
        }
    }
}

/// 1 つのジオメトリ (ヘッダ込み) を読み、WKT と (あれば) SRID を返す。`ewkb` が真なら SRID フラグを解釈する。
fn read_geometry(r: &mut Reader<'_>, depth: u32, ewkb: bool) -> Option<(String, Option<u32>)> {
    if depth > MAX_DEPTH {
        return None;
    }
    let le = match r.u8()? {
        1 => true,
        0 => false,
        _ => return None,
    };
    let t = r.u32(le)?;
    let (mut z, mut m) = (t & FLAG_Z != 0, t & FLAG_M != 0);
    let has_srid = ewkb && t & FLAG_SRID != 0;
    // ISO 形式 (1000 = Z, 2000 = M, 3000 = ZM) にも対応する (MySQL / 他ツール由来)。
    let code = t & 0x1FFF_FFFF;
    match code / 1000 {
        0 => {}
        1 => z = true,
        2 => m = true,
        3 => {
            z = true;
            m = true;
        }
        _ => return None,
    }
    let kind = code % 1000;
    let srid = if has_srid { Some(r.u32(le)?) } else { None };
    let dim = Dim { z, m };
    let body = match kind {
        1 => read_point(r, le, dim)?,
        2 => read_line(r, le, dim)?,
        3 => read_polygon(r, le, dim)?,
        4..=7 => read_collection(r, le, dim, kind, depth)?,
        _ => return None,
    };
    let tag = match kind {
        1 => "POINT",
        2 => "LINESTRING",
        3 => "POLYGON",
        4 => "MULTIPOINT",
        5 => "MULTILINESTRING",
        6 => "MULTIPOLYGON",
        _ => "GEOMETRYCOLLECTION",
    };
    Some((render(tag, dim, body, kind == 7), srid))
}

/// 中身 (`None` = EMPTY) をタグと組み合わせる。次元指定 (` Z`) を付けるときは括弧の前に空白を入れる
/// (`POINT Z (1 2 3)`)。2 次元は `POINT(1 2)`。
fn render(tag: &str, dim: Dim, body: Option<String>, is_collection: bool) -> String {
    let suffix = dim.suffix();
    match body {
        None => format!("{tag}{suffix} EMPTY"),
        Some(b) if suffix.is_empty() || is_collection => {
            // GeometryCollection は子がそれぞれ次元を持つので、親では付けない (空のときだけ別)。
            format!("{tag}({b})")
        }
        Some(b) => format!("{tag}{suffix} ({b})"),
    }
}

fn fmt_f64(v: f64) -> Option<String> {
    if !v.is_finite() {
        return None;
    }
    // `-0` は `0` に揃える (見た目のノイズ。書き戻しても同じ点)。
    if v == 0.0 {
        return Some("0".to_string());
    }
    Some(v.to_string())
}

/// 座標 1 点 (`x y [z] [m]`)。全成分が NaN なら EMPTY の点 (PostGIS の `POINT EMPTY` の表現) として `Ok(None)`。
fn read_position(r: &mut Reader<'_>, le: bool, dim: Dim) -> Option<Option<String>> {
    let mut parts = Vec::with_capacity(dim.n());
    let mut nan = 0;
    for _ in 0..dim.n() {
        let v = r.f64(le)?;
        if v.is_nan() {
            nan += 1;
            continue;
        }
        parts.push(fmt_f64(v)?);
    }
    if nan == dim.n() {
        return Some(None);
    }
    if nan > 0 {
        return None;
    }
    Some(Some(parts.join(" ")))
}

fn read_point(r: &mut Reader<'_>, le: bool, dim: Dim) -> Option<Option<String>> {
    read_position(r, le, dim)
}

/// 個数 `n` の点が残りバイト数に収まるか (壊れたデータで巨大な確保をしない)。
fn fits(r: &Reader<'_>, n: u32, per: usize) -> bool {
    (n as usize)
        .checked_mul(per)
        .is_some_and(|b| b <= r.remaining())
}

fn read_points(r: &mut Reader<'_>, le: bool, dim: Dim) -> Option<Vec<String>> {
    let n = r.u32(le)?;
    if !fits(r, n, 8 * dim.n()) {
        return None;
    }
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        // 線・環の中の点に EMPTY は無い。
        out.push(read_position(r, le, dim)??);
    }
    Some(out)
}

fn read_line(r: &mut Reader<'_>, le: bool, dim: Dim) -> Option<Option<String>> {
    let pts = read_points(r, le, dim)?;
    Some(if pts.is_empty() {
        None
    } else {
        Some(pts.join(","))
    })
}

fn read_rings(r: &mut Reader<'_>, le: bool, dim: Dim) -> Option<Vec<String>> {
    let n = r.u32(le)?;
    // 環 1 つは最低でも 4 バイト (点数) 要る。
    if !fits(r, n, 4) {
        return None;
    }
    let mut out = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let pts = read_points(r, le, dim)?;
        out.push(if pts.is_empty() {
            "EMPTY".to_string()
        } else {
            format!("({})", pts.join(","))
        });
    }
    Some(out)
}

fn read_polygon(r: &mut Reader<'_>, le: bool, dim: Dim) -> Option<Option<String>> {
    let rings = read_rings(r, le, dim)?;
    Some(if rings.is_empty() {
        None
    } else {
        Some(rings.join(","))
    })
}

/// Multi* / GeometryCollection。子はそれぞれヘッダを持つ。
fn read_collection(
    r: &mut Reader<'_>,
    le: bool,
    _dim: Dim,
    kind: u32,
    depth: u32,
) -> Option<Option<String>> {
    let n = r.u32(le)?;
    // 子 1 つは最低でも 5 バイト (バイトオーダー + タイプ)。
    if !fits(r, n, 5) {
        return None;
    }
    let mut parts: Vec<String> = Vec::with_capacity(n as usize);
    for _ in 0..n {
        let start = r.pos;
        let (child, _) = read_geometry(r, depth + 1, false)?;
        let child_kind = child_kind_code(r.b, start)?;
        let expected = match kind {
            4 => 1,
            5 => 2,
            6 => 3,
            _ => 0,
        };
        if expected != 0 && child_kind != expected {
            return None;
        }
        parts.push(if kind == 7 { child } else { strip_tag(&child) });
    }
    Some(if parts.is_empty() {
        None
    } else {
        Some(parts.join(","))
    })
}

/// 子ジオメトリの種別コード (1..=7)。ヘッダを読み直して得る。
fn child_kind_code(b: &[u8], start: usize) -> Option<u32> {
    let le = match *b.get(start)? {
        1 => true,
        0 => false,
        _ => return None,
    };
    let a: [u8; 4] = b.get(start + 1..start + 5)?.try_into().ok()?;
    let t = if le {
        u32::from_le_bytes(a)
    } else {
        u32::from_be_bytes(a)
    };
    Some((t & 0x1FFF_FFFF) % 1000)
}

/// 子の WKT からタグと次元指定を外す。`POINT(1 2)` → `(1 2)`、`POINT Z (1 2 3)` → `(1 2 3)`、
/// `POINT EMPTY` → `EMPTY`。Multi* の子は括弧付きの座標リストだけを並べる形 (`MULTIPOINT((1 2),(3 4))`)。
fn strip_tag(child: &str) -> String {
    if child.ends_with("EMPTY") {
        return "EMPTY".to_string();
    }
    match child.find('(') {
        Some(i) => child[i..].to_string(),
        None => child.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(le: bool, flags: u32, srid: Option<u32>, coords: &[f64]) -> Vec<u8> {
        let mut v = vec![if le { 1 } else { 0 }];
        let t = 1 | flags | if srid.is_some() { FLAG_SRID } else { 0 };
        v.extend(if le { t.to_le_bytes() } else { t.to_be_bytes() });
        if let Some(s) = srid {
            v.extend(if le { s.to_le_bytes() } else { s.to_be_bytes() });
        }
        for c in coords {
            v.extend(if le { c.to_le_bytes() } else { c.to_be_bytes() });
        }
        v
    }

    fn header(kind: u32, flags: u32, srid: Option<u32>) -> Vec<u8> {
        let mut v = vec![1u8];
        let t = kind | flags | if srid.is_some() { FLAG_SRID } else { 0 };
        v.extend(t.to_le_bytes());
        if let Some(s) = srid {
            v.extend(s.to_le_bytes());
        }
        v
    }

    fn f(v: &mut Vec<u8>, xs: &[f64]) {
        for x in xs {
            v.extend(x.to_le_bytes());
        }
    }

    fn n(v: &mut Vec<u8>, c: u32) {
        v.extend(c.to_le_bytes());
    }

    #[test]
    fn ewkb_point_with_srid() {
        let b = pt(true, 0, Some(4326), &[139.76, 35.68]);
        assert_eq!(
            ewkb_to_ewkt(&b).as_deref(),
            Some("SRID=4326;POINT(139.76 35.68)")
        );
    }

    #[test]
    fn ewkb_srid_zero_and_missing_have_no_prefix() {
        let none = pt(true, 0, None, &[1.0, 2.0]);
        assert_eq!(ewkb_to_ewkt(&none).as_deref(), Some("POINT(1 2)"));
        let zero = pt(true, 0, Some(0), &[1.5, -2.0]);
        assert_eq!(ewkb_to_ewkt(&zero).as_deref(), Some("POINT(1.5 -2)"));
    }

    #[test]
    fn ewkb_big_endian_point() {
        let b = pt(false, 0, Some(3857), &[10.0, 20.0]);
        assert_eq!(ewkb_to_ewkt(&b).as_deref(), Some("SRID=3857;POINT(10 20)"));
    }

    #[test]
    fn ewkb_z_m_zm_points() {
        let z = pt(true, FLAG_Z, Some(4326), &[1.0, 2.0, 3.0]);
        assert_eq!(
            ewkb_to_ewkt(&z).as_deref(),
            Some("SRID=4326;POINT Z (1 2 3)")
        );
        let m = pt(true, FLAG_M, None, &[1.0, 2.0, 7.0]);
        assert_eq!(ewkb_to_ewkt(&m).as_deref(), Some("POINT M (1 2 7)"));
        let zm = pt(true, FLAG_Z | FLAG_M, None, &[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(ewkb_to_ewkt(&zm).as_deref(), Some("POINT ZM (1 2 3 4)"));
    }

    #[test]
    fn iso_style_z_type_code() {
        // ISO: 1001 = POINT Z。
        let mut v = vec![1u8];
        v.extend(1001u32.to_le_bytes());
        f(&mut v, &[1.0, 2.0, 3.0]);
        assert_eq!(ewkb_to_ewkt(&v).as_deref(), Some("POINT Z (1 2 3)"));
    }

    #[test]
    fn empty_point_is_nan_nan() {
        let b = pt(true, 0, Some(4326), &[f64::NAN, f64::NAN]);
        assert_eq!(ewkb_to_ewkt(&b).as_deref(), Some("SRID=4326;POINT EMPTY"));
    }

    #[test]
    fn partially_nan_point_is_rejected() {
        let b = pt(true, 0, None, &[1.0, f64::NAN]);
        assert_eq!(ewkb_to_ewkt(&b), None);
    }

    #[test]
    fn empty_linestring_and_polygon() {
        let mut l = header(2, 0, Some(4326));
        n(&mut l, 0);
        assert_eq!(
            ewkb_to_ewkt(&l).as_deref(),
            Some("SRID=4326;LINESTRING EMPTY")
        );
        let mut p = header(3, 0, None);
        n(&mut p, 0);
        assert_eq!(ewkb_to_ewkt(&p).as_deref(), Some("POLYGON EMPTY"));
    }

    #[test]
    fn linestring_and_polygon_with_hole() {
        let mut l = header(2, 0, None);
        n(&mut l, 2);
        f(&mut l, &[0.0, 0.0, 1.0, 1.0]);
        assert_eq!(ewkb_to_ewkt(&l).as_deref(), Some("LINESTRING(0 0,1 1)"));

        let mut p = header(3, 0, Some(4326));
        n(&mut p, 2);
        n(&mut p, 4);
        f(&mut p, &[0.0, 0.0, 4.0, 0.0, 4.0, 4.0, 0.0, 0.0]);
        n(&mut p, 4);
        f(&mut p, &[1.0, 1.0, 2.0, 1.0, 2.0, 2.0, 1.0, 1.0]);
        assert_eq!(
            ewkb_to_ewkt(&p).as_deref(),
            Some("SRID=4326;POLYGON((0 0,4 0,4 4,0 0),(1 1,2 1,2 2,1 1))")
        );
    }

    #[test]
    fn multipoint_multiline_multipolygon() {
        let mut mp = header(4, 0, None);
        n(&mut mp, 2);
        mp.extend(pt(true, 0, None, &[1.0, 2.0]));
        mp.extend(pt(true, 0, None, &[3.0, 4.0]));
        assert_eq!(
            ewkb_to_ewkt(&mp).as_deref(),
            Some("MULTIPOINT((1 2),(3 4))")
        );

        let mut ml = header(5, 0, None);
        n(&mut ml, 1);
        ml.extend(header(2, 0, None));
        n(&mut ml, 2);
        f(&mut ml, &[0.0, 0.0, 1.0, 1.0]);
        assert_eq!(
            ewkb_to_ewkt(&ml).as_deref(),
            Some("MULTILINESTRING((0 0,1 1))")
        );

        let mut mg = header(6, 0, Some(4326));
        n(&mut mg, 1);
        mg.extend(header(3, 0, None));
        n(&mut mg, 1);
        n(&mut mg, 4);
        f(&mut mg, &[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0]);
        assert_eq!(
            ewkb_to_ewkt(&mg).as_deref(),
            Some("SRID=4326;MULTIPOLYGON(((0 0,1 0,1 1,0 0)))")
        );
    }

    #[test]
    fn multi_with_z_keeps_dimension_on_the_outer_tag_only() {
        let mut mp = header(4, FLAG_Z, None);
        n(&mut mp, 1);
        mp.extend(pt(true, FLAG_Z, None, &[1.0, 2.0, 3.0]));
        assert_eq!(ewkb_to_ewkt(&mp).as_deref(), Some("MULTIPOINT Z ((1 2 3))"));
    }

    #[test]
    fn empty_multi_and_collection() {
        let mut m = header(6, 0, None);
        n(&mut m, 0);
        assert_eq!(ewkb_to_ewkt(&m).as_deref(), Some("MULTIPOLYGON EMPTY"));
        let mut g = header(7, 0, Some(4326));
        n(&mut g, 0);
        assert_eq!(
            ewkb_to_ewkt(&g).as_deref(),
            Some("SRID=4326;GEOMETRYCOLLECTION EMPTY")
        );
    }

    #[test]
    fn geometry_collection_nests_full_tags() {
        let mut g = header(7, 0, Some(4326));
        n(&mut g, 2);
        g.extend(pt(true, 0, None, &[1.0, 2.0]));
        g.extend(header(2, 0, None));
        n(&mut g, 2);
        f(&mut g, &[0.0, 0.0, 5.0, 5.0]);
        assert_eq!(
            ewkb_to_ewkt(&g).as_deref(),
            Some("SRID=4326;GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,5 5))")
        );
    }

    #[test]
    fn collection_with_empty_child() {
        let mut g = header(7, 0, None);
        n(&mut g, 1);
        g.extend(pt(true, 0, None, &[f64::NAN, f64::NAN]));
        assert_eq!(
            ewkb_to_ewkt(&g).as_deref(),
            Some("GEOMETRYCOLLECTION(POINT EMPTY)")
        );
    }

    #[test]
    fn mismatched_multi_child_is_rejected() {
        let mut mp = header(4, 0, None);
        n(&mut mp, 1);
        mp.extend(header(2, 0, None));
        n(&mut mp, 0);
        assert_eq!(ewkb_to_ewkt(&mp), None);
    }

    #[test]
    fn malformed_input_is_none_not_panic() {
        assert_eq!(ewkb_to_ewkt(&[]), None);
        assert_eq!(ewkb_to_ewkt(&[1]), None);
        assert_eq!(ewkb_to_ewkt(&[2, 1, 0, 0, 0]), None);
        // 点数が実データより多い。
        let mut l = header(2, 0, None);
        n(&mut l, 1_000_000);
        f(&mut l, &[0.0, 0.0]);
        assert_eq!(ewkb_to_ewkt(&l), None);
        // 末尾に余計なバイト。
        let mut p = pt(true, 0, None, &[1.0, 2.0]);
        p.push(0);
        assert_eq!(ewkb_to_ewkt(&p), None);
        // 未対応 (CircularString = 8)。
        let c = header(8, 0, None);
        assert_eq!(ewkb_to_ewkt(&c), None);
        // 深すぎる入れ子。
        let mut deep = Vec::new();
        for _ in 0..20 {
            deep.extend(header(7, 0, None));
            n(&mut deep, 1);
        }
        assert_eq!(ewkb_to_ewkt(&deep), None);
    }

    #[test]
    fn hex_text_format_decodes() {
        // POINT(1 2) の EWKB 16 進 (リトルエンディアン、SRID 4326)。
        let b = pt(true, 0, Some(4326), &[1.0, 2.0]);
        let hex = data_encoding::HEXUPPER.encode(&b);
        assert_eq!(
            ewkb_hex_to_ewkt(hex.as_bytes()).as_deref(),
            Some("SRID=4326;POINT(1 2)")
        );
        assert_eq!(ewkb_hex_to_ewkt(b"zz"), None);
    }

    #[test]
    fn mysql_internal_format_srid_prefix() {
        // SRID 4326 + WKB POINT(35.68 139.76) (内部形式に入っている順のまま出す)。
        let mut v = 4326u32.to_le_bytes().to_vec();
        v.extend(pt(true, 0, None, &[35.68, 139.76]));
        assert_eq!(
            mysql_geometry_to_ewkt(&v).as_deref(),
            Some("SRID=4326;POINT(35.68 139.76)")
        );
    }

    #[test]
    fn mysql_srid_zero_has_no_prefix() {
        let mut v = 0u32.to_le_bytes().to_vec();
        v.extend(pt(true, 0, None, &[1.0, 2.0]));
        assert_eq!(mysql_geometry_to_ewkt(&v).as_deref(), Some("POINT(1 2)"));
    }

    #[test]
    fn mysql_polygon_and_empty_collection() {
        let mut v = 0u32.to_le_bytes().to_vec();
        v.extend(header(3, 0, None));
        n(&mut v, 1);
        n(&mut v, 4);
        f(&mut v, &[0.0, 0.0, 2.0, 0.0, 2.0, 2.0, 0.0, 0.0]);
        assert_eq!(
            mysql_geometry_to_ewkt(&v).as_deref(),
            Some("POLYGON((0 0,2 0,2 2,0 0))")
        );
        let mut e = 4326u32.to_le_bytes().to_vec();
        e.extend(header(7, 0, None));
        n(&mut e, 0);
        assert_eq!(
            mysql_geometry_to_ewkt(&e).as_deref(),
            Some("SRID=4326;GEOMETRYCOLLECTION EMPTY")
        );
    }

    #[test]
    fn mysql_rejects_short_or_trailing_bytes() {
        assert_eq!(mysql_geometry_to_ewkt(&[1, 2]), None);
        assert_eq!(mysql_geometry_to_ewkt(&[0, 0, 0, 0]), None);
        let mut v = 0u32.to_le_bytes().to_vec();
        v.extend(pt(true, 0, None, &[1.0, 2.0]));
        v.push(9);
        assert_eq!(mysql_geometry_to_ewkt(&v), None);
    }

    #[test]
    fn negative_zero_and_fractions() {
        let b = pt(true, 0, None, &[-0.0, 0.000001]);
        assert_eq!(ewkb_to_ewkt(&b).as_deref(), Some("POINT(0 0.000001)"));
    }

    #[test]
    fn split_ewkt_cases() {
        assert_eq!(
            split_ewkt("SRID=4326;POINT(1 2)"),
            (Some(4326), "POINT(1 2)")
        );
        assert_eq!(split_ewkt("srid=0; POINT(1 2) "), (Some(0), "POINT(1 2)"));
        assert_eq!(split_ewkt("POINT(1 2)"), (None, "POINT(1 2)"));
        assert_eq!(split_ewkt("SRID=x;POINT(1 2)"), (None, "SRID=x;POINT(1 2)"));
        assert_eq!(split_ewkt("SRID=4326"), (None, "SRID=4326"));
    }

    #[test]
    fn sql_literal_uses_st_geomfromtext() {
        assert_eq!(
            spatial_sql_literal(DriverKind::Postgres, "SRID=4326;POINT(1 2)").as_deref(),
            Some("ST_GeomFromText('POINT(1 2)', 4326)")
        );
        // MySQL は経度, 緯度の順で読ませる (SRID 0 以外)。
        assert_eq!(
            spatial_sql_literal(DriverKind::Mysql, "SRID=4326;POINT(139.76 35.68)").as_deref(),
            Some("ST_GeomFromText('POINT(139.76 35.68)', 4326, 'axis-order=long-lat')")
        );
        assert_eq!(
            spatial_sql_literal(DriverKind::Mysql, "POINT(1 2)").as_deref(),
            Some("ST_GeomFromText('POINT(1 2)')")
        );
        assert_eq!(
            spatial_sql_literal(DriverKind::Mysql, "SRID=0;POINT EMPTY").as_deref(),
            Some("ST_GeomFromText('POINT EMPTY', 0)")
        );
        assert_eq!(spatial_sql_literal(DriverKind::Sqlite, "POINT(1 2)"), None);
        // 引用符・セミコロンなど WKT に現れない文字は拒否 (通常の文字列リテラルへ戻す)。
        assert_eq!(
            spatial_sql_literal(DriverKind::Mysql, "POINT(1 2)'); DROP TABLE t; --"),
            None
        );
        assert_eq!(spatial_sql_literal(DriverKind::Postgres, ""), None);
    }

    #[test]
    fn column_detection_is_driver_aware() {
        for t in [
            "geometry",
            "GEOMETRY",
            "point",
            "POLYGON",
            "linestring",
            "multipolygon",
            "geometrycollection",
            "geomcollection",
            "MultiPoint",
        ] {
            assert!(is_spatial_column(DriverKind::Mysql, t), "{t}");
        }
        assert!(!is_spatial_column(DriverKind::Mysql, "text"));
        assert!(is_spatial_column(DriverKind::Postgres, "geography"));
        // PostgreSQL 標準の幾何型は PostGIS ではない。
        assert!(!is_spatial_column(DriverKind::Postgres, "point"));
        assert!(!is_spatial_column(DriverKind::Postgres, "polygon"));
        // SQLite は SpatiaLite を前提にしない。
        assert!(!is_spatial_column(DriverKind::Sqlite, "GEOMETRY"));
    }

    #[test]
    fn type_name_detection() {
        for t in [
            "geometry",
            "GEOMETRY",
            "geography",
            "geometry(Point,4326)",
            "public.geometry",
            "\"public\".\"geometry\"",
        ] {
            assert!(is_spatial_type_name(t), "{t}");
        }
        for t in [
            "point",
            "POINT",
            "polygon",
            "text",
            "BLOB",
            "geometry_columns",
        ] {
            assert!(!is_spatial_type_name(t), "{t}");
        }
    }

    #[test]
    fn spatial_import_placeholder_per_driver() {
        assert_eq!(
            spatial_import_placeholder(DriverKind::Mysql),
            Some("ST_GeomFromText(?, ?, 'axis-order=long-lat')")
        );
        // PostgreSQL は EWKT のテキストをそのまま受ける。SQLite は対象外。
        assert_eq!(spatial_import_placeholder(DriverKind::Postgres), None);
        assert_eq!(spatial_import_placeholder(DriverKind::Sqlite), None);
    }

    #[test]
    fn mysql_spatial_binds_split_srid() {
        assert_eq!(
            mysql_spatial_binds(Some("SRID=4326;POINT(1 2)")),
            (Some("POINT(1 2)"), 4326)
        );
        assert_eq!(
            mysql_spatial_binds(Some("POINT(1 2)")),
            (Some("POINT(1 2)"), 0)
        );
        assert_eq!(mysql_spatial_binds(None), (None, 0));
    }
}
