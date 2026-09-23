# 04 — แหล่งข้อมูล + วิธีดึง

> รวบรวม 23 ก.ย. 2026 — ถ้าจะรีเฟรชข้อมูล รันคำสั่งข้างล่างซ้ำ

## แหล่งที่เป็นทางการ

| แหล่ง | URL |
|---|---|
| งานหลัก + สมัคร | https://colosseum.com/worldsfair |
| กติกา/FAQ | https://colosseum.com/hackathon |
| ประกาศเปิดงาน | https://blog.colosseum.com/expanding-the-arena/ |
| รวม side tracks | https://superteam.fun/earn/hackathon/crypto-worlds-fair |
| Track ไทย | https://superteam.fun/earn/listing/ai-solana-track/ |
| หน้า Superteam TH | https://superteam.fun/earn/regions/thailand |
| Build Station BKK | https://luma.com/i8gz6cab |
| Office Hours | https://luma.com/2k5vplzo |

## API ที่ใช้ดึง (public ไม่ต้อง login)

- รายชื่อ 31 side tracks: `GET https://superteam.fun/api/hackathon/crypto-worlds-fair`
  → เซฟที่ `data/sidetracks-raw.json` (สรุปอ่านง่าย: `data/sidetracks-index.txt`)
- รายละเอียดราย track: ดึง HTML `https://superteam.fun/earn/listing/<slug>/` แล้วแกะ `<script id="__NEXT_DATA__">`
  → เซฟที่ `data/listings/<slug>.json` (ครบ 31 อัน), ตารางสรุป `data/listings-summary.txt`
- ฟิลด์ตัดสินสิทธิ์คือ `listing.region` — Global/Thailand = เราส่งได้ (ยกเว้น Vietnam ที่บรีฟบังคับ base=Việt Nam)

## เรื่อง login / MCP

- ข้อมูล public ทั้งหมดดึงได้โดยไม่ต้อง login (API + SSR HTML) — Playwright ใช้แค่ยืนยันหน้าเว็บที่ render ฝั่ง client
- `GET /api/agents/listings/live` (Agent API) ตอบ **401 Unauthorized** — ต้องมี API key ฝั่ง agent ถึงใช้ได้ (`data/agent-api-probe.json`)
- ติดตั้ง skill เสริมแล้ว: `solana-foundation/solana-dev-skill` (official, 72K+ installs) ไว้ช่วยเขียนโค้ด Solana ตอนบิลด์
- ไม่ต้องใช้ token ที่ให้มาในรอบนี้เพราะไม่มีหน้าที่ต้อง login — เก็บ token ไว้ ถ้าต้องเข้าไปดู submission portal / dashboard ค่อยใช้

## ไฟล์ใน repo

```text
README.md              ดัชนี + เช็กลิสต์
research/00-overview.md            ภาพรวมงาน รางวัล กำหนดการ
research/01-colosseum-rules.md     กติกาหลัก เกณฑ์ตัดสิน
research/02-eligible-sidetracks.md 6 track ที่สมัครได้ + กลยุทธ์ซ้อนรางวัล
research/03-thailand-support.md    ตัวช่วยฝั่งไทย
research/04-sources.md             ไฟล์นี้
tracks/*.md            บรีฟฉบับเต็ม 6 track ที่สมัครได้
data/sidetracks-raw.json           รายชื่อ 31 tracks ดิบ
data/sidetracks-index.txt          รายชื่ออ่านง่าย
data/listings/*.json               รายละเอียดดิบครบ 31 tracks
data/listings-summary.txt          ตาราง region/รางวัล/deadline 31 tracks
data/agent-api-probe.json          ผล probe Agent API (401)
```

## รีเฟรชข้อมูล

```powershell
cd C:\Users\suanw\projects\hack
curl.exe -s 'https://superteam.fun/api/hackathon/crypto-worlds-fair' -o data/sidetracks-raw.json
# แล้วแกะ __NEXT_DATA__ จากหน้า listing ที่ต้องการ (ดูวิธีในไฟล์นี้หัวข้อ API)
```
