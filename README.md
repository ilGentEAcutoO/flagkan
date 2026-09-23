# hack — Crypto World's Fair 2026 war room

Repo เตรียมตัวแข่งแฮกกาธอน **Crypto World's Fair** (Colosseum, 14 ก.ย. – 12 ต.ค. 2026)
เก็บข้อมูล deep-research ไว้เป็น knowledge ก่อนลงมือสร้างโปรเจกต์

## เวลาที่เหลือ (ณ 23 ก.ย. 2026)

- ส่งงานหลัก Colosseum: **13 ต.ค. 2026 13:59 น. เวลาไทย** (12 Oct 23:59 PT ≈ 13 Oct 06:59 UTC) — เหลือ ~19 วัน
- ส่ง side track บน Superteam Earn: **deadline เดียวกันทุก track**
- ประกาศผล track ไทย: ~27 ต.ค. 2026 / ผลหลัก Colosseum: ~1 เดือนหลังปิดรับ (~กลาง พ.ย.)

## โครง repo

```text
research/   บทสรุปอ่านก่อน (เริ่มตรงนี้)
tracks/     บรีฟฉบับเต็มราย track ที่เราสมัครได้ (7 ไฟล์)
data/       raw JSON ดิบจาก API + หน้าเว็บ (31 tracks ครบ)
```

## track ที่คนไทย (บุคคลทั่วไป, ไม่ใช่นักศึกษา) สมัครได้ — 6 อัน

| # | Track | Pool | ส่งอะไร |
|---|---|---|---|
| 1 | [AI × Solana — Thailand](tracks/ai-solana-track.md) | $10,000 | โปรดักต์ AI + Solana ใช้งานจริง |
| 2 | [Meteora DBC](tracks/meteora-dbc.md) | $20,000 USDC | launchpad / token launch บน DBC + DAMM v2 |
| 3 | [RPC Fast Infra](tracks/colosseum-crypto-worlds-fair-hackathon-rpc-fast-infrastructure-sidetrack.md) | $10,474 USDC | ใช้ RPC Fast + โพสต์ engagement 2 เดือน |
| 4 | [Panta API](tracks/panta-api-side-track.md) | $5,000 | สินค้าที่ฝัง prediction market ผ่าน Panta API |
| 5 | [Solami data](tracks/build-something-live-on-solana-data.md) | $3,000 | ของที่รัน live บน Solana data (RPC/gRPC/Blur/Beam) + repo public |
| 6 | [Adevar pre-audit](tracks/pre-audit-credits-adevarlabs.md) | $20,000 credits | โปรเจกต์ Solana/Rust + ทวีต (รางวัลเป็น pre-audit ไม่ใช่เงินสด) |

กลยุทธ์ซ้อนรางวัล: โปรเจกต์เดียวส่งได้ทั้ง Colosseum หลัก + side track หลายอันพร้อมกัน
(เช่น AI agent บน Solana ที่ใช้ Meteora DBC + อ่านข้อมูลผ่าน Solami + รันบน RPC Fast = ลุ้น 4–5 กองพร้อมกัน)
รายละเอียดใน [research/02-eligible-sidetracks.md](research/02-eligible-sidetracks.md)

## เช็กลิสต์ก่อนส่ง

- [ ] สมัคร Colosseum + เลือกประเทศ **Thailand** (https://colosseum.com/worldsfair)
- [ ] สร้างโปรไฟล์ Superteam Earn + เลือก region Thailand (**ห้ามย้าย region บ่อย** — มี cooldown 21 วัน)
- [ ] ส่งโปรเจกต์บน Colosseum (ชื่อ, คำอธิบาย, GitHub, วิดีโอ pitch 2–3 นาที, วิดีโอ demo ≤3 นาที, GTM)
- [ ] ส่งแยกบน Superteam Earn ทุก side track ที่เล็ง (ฟอร์มถามชื่อโปรเจกต์, GitHub, เว็บ, X, pitch deck/วิดีโอ, ลิงก์ Colosseum)
- [ ] อัปเดตรายสัปดาห์ (คลิป 1 นาที — ไม่บังคับแต่แนะนำ)
- [ ] เปิดเผย pre-existing code ในฟอร์มส่งงาน (ถ้ามี)

## อ่านต่อ

1. [research/00-overview.md](research/00-overview.md) — ภาพรวมงาน รางวัล กำหนดการ
2. [research/01-colosseum-rules.md](research/01-colosseum-rules.md) — กติกาหลัก เกณฑ์ตัดสิน สิ่งที่ต้องส่ง
3. [research/02-eligible-sidetracks.md](research/02-eligible-sidetracks.md) — 6 track ที่สมัครได้ + track ที่อด
4. [research/03-thailand-support.md](research/03-thailand-support.md) — Build Station, Office Hours, ช่องทาง Superteam TH
5. [research/04-sources.md](research/04-sources.md) — แหล่งข้อมูล + วิธีดึงข้อมูล
