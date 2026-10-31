# העלאה לאחסון Node.js

הדומיין: **smartv-il.live** · תיקיית האפליקציה בשרת: `smartlive`

המדריך הזה מתאים לאחסון Node מנוהל עם cPanel (הכפתור **Setup Node.js App**),
שזה מה שרוב ספקי ה‑Node Hosting נותנים. אם יש לך גישת SSH — יותר קל, מצוין בסוף.

## לפני שמתחילים

צריך שיהיה לך ביד:

- פרטי cPanel (כתובת, שם משתמש, סיסמה)
- הדומיין או הסאב‑דומיין שהאתר ישב עליו
- התוכן של `.env` מהמחשב — הוא **לא** נמצא ב‑repo בכוונה

## 1. להעלות את הקבצים

**אם יש SSH** (הכי נוח — גם עדכונים אחר כך הם פקודה אחת):

```bash
cd ~
git clone https://github.com/idanohana/SmartLive.git smartlive
```

**בלי SSH:** הורד ZIP מ‑GitHub (Code → Download ZIP), העלה דרך File Manager
לתיקייה כמו `/home/<user>/smartlive`, ופתח אותו שם.

> אל תעלה את `node_modules` — האחסון מתקין את החבילות בעצמו.

## 2. ליצור את האפליקציה ב‑cPanel

**Setup Node.js App → Create Application**, ומלא:

| שדה | ערך |
| --- | --- |
| Node.js version | 20 או 18 |
| Application mode | Production |
| Application root | `smartlive` (התיקייה מהשלב הקודם) |
| Application URL | הדומיין שבחרת |
| Application startup file | `app.js` |

## 3. משתני סביבה

באותו מסך יש **Environment variables**. הוסף אותם משם — לא כקובץ:

| שם | ערך |
| --- | --- |
| `SUPABASE_URL` | כמו ב‑`.env` שלך |
| `SUPABASE_SERVICE_KEY` | כמו ב‑`.env` שלך |
| `SESSION_SECRET` | מחרוזת אקראית ארוכה (ראה למטה) |
| `IPTV_HOST` / `IPTV_USERNAME` / `IPTV_PASSWORD` | רק אם זו התקנה חדשה שצריך לזרוע בה מנהל |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | רק להתקנה חדשה |

ל‑`SESSION_SECRET` אפשר לייצר ערך כך:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**למה זה חשוב:** בלי `SESSION_SECRET` קבוע, כל הפעלה מחדש של האפליקציה מנתקת
את כל המשתמשים.

## 4. להתקין ולהפעיל

במסך האפליקציה: **Run NPM Install**, ואז **Restart**.

ב‑SSH זה נראה כך:

```bash
source /home/<user>/nodevenv/smartlive/20/bin/activate && cd ~/smartlive && npm install
```

## 5. לבדוק

1. פתח `https://smartv-il.live/` — אמור להופיע מסך הכניסה.
2. התחבר, ובדוק שהערוצים נטענים ושאחד מהם מתנגן.
3. `https://smartv-il.live/admin` — ניהול המשתמשים.

אם הדומיין מחזיר שגיאה, המקום לבדוק הוא **Logs** במסך האפליקציה ב‑cPanel.

## 6. להפנות את אפליקציית הטלוויזיה

בטלוויזיה: פתח את SmartLive, לחץ **MENU** בשלט, והחלף את הכתובת לדומיין החדש.

כדי שזו תהיה ברירת המחדל בהתקנות חדשות, שנה את `DEFAULT_SERVER` בקובץ
`android/app/src/main/java/com/smartlive/tv/MainActivity.java` ובנה מחדש:

```bash
cd android && gradle assembleRelease
```

## עדכונים אחרי שינוי בקוד

### פעם אחת: להפוך את התיקייה בשרת לעותק של ה‑repo

אם העלית את הקבצים כ‑ZIP, התיקייה בשרת היא רק קבצים — היא לא יודעת מאיפה הם
הגיעו. המעבר הזה נעשה פעם אחת, ואחריו כל עדכון הוא פקודה אחת.

**עם cPanel Terminal** (Advanced → Terminal):

```bash
cd ~ && mv smartlive smartlive-old && git clone https://github.com/idanohana/SmartLive.git smartlive
```

הפרויקט פרטי, אז git יבקש שם משתמש וסיסמה. בשדה הסיסמה מדביקים **Personal
Access Token** מ‑GitHub (Settings → Developer settings → Personal access tokens
→ Fine-grained → הרשאת Contents: Read) ולא את סיסמת החשבון.

```bash
cd ~/smartlive && npm install --omit=dev && chmod +x deploy.sh
```

כשהכול עובד אפשר למחוק את הגיבוי: `rm -rf ~/smartlive-old`.

### מכאן והלאה: עדכון בפקודה אחת

```bash
cd ~/smartlive && ./deploy.sh
```

הסקריפט מושך את הקוד, מתקין תלויות **רק אם** הן השתנו, ומפעיל מחדש דרך
`tmp/restart.txt` — בלי להיכנס למסך האפליקציה.

### בלי Terminal בכלל: Git Version Control

ב‑cPanel יש **Git™ Version Control**. יוצרים שם מאגר, מדביקים את כתובת ה‑repo,
ואחר כך יש כפתור **Update from Remote** שמושך את השינויים בלחיצה. לפרויקט פרטי
צריך להוסיף את מפתח ה‑SSH שה‑cPanel מייצר כ‑**Deploy key** ב‑GitHub
(Settings → Deploy keys → Add deploy key). אחרי העדכון עדיין צריך **Restart**
במסך האפליקציה.

### הדרך הישנה: ZIP

עדיין עובדת — מעלים את ה‑ZIP לתיקייה, **Extract** עם דריסה, ואז **Restart**.
טובה לעדכון חד‑פעמי, מייגעת כשיטה קבועה.

## מה לבדוק אם השידור החי מקרטע

האחסון הזה הוא 2 ליבות ו‑2GB RAM, וזה מספיק — הפרוקסי רק מעביר בייטים, הוא לא
מפענח וידאו. שני דברים כן עלולים לעצור אותו:

1. **מגבלת החיבורים של המנוי** (`max_connections`, כרגע 1). שני צופים במקביל
   ינתקו זה את זה. זה מספר שמשנים אצל ספק ה‑IPTV.
2. **proxy שמבצע buffering**. השרת כבר שולח `X-Accel-Buffering: no`, שמטפל
   בזה ברוב ההגדרות. אם בכל זאת יש השהיה ארוכה לפני שהתמונה עולה, זה החשוד.
