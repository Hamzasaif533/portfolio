# Ham7a — personal site

A black, monospace personal site with six pages: Hey, Code, Design, Shelf, About and Writing.
It has no dependencies and builds to static HTML. The Arabic font (Firjar) loads only on pages that contain Arabic.

## Run it (Windows PowerShell)

```bash
node build.js --dev
```

- Site: http://localhost:5500
- **Editor: http://localhost:5500/admin**: add, edit, delete and reorder anything, upload images and videos, and write posts. Saving rebuilds the site instantly.

On your computer the editor saves straight to your files: the server answers only this machine, and every change needs a secret key created fresh each time it starts. Every save keeps a backup in `content/.backup/` (the last 30), and deleted posts go to `content/.trash/`.

```bash
node build.js
```

This writes the finished site into `dist/`.

## Edit from anywhere (phone, iPad, any computer)

Your site's files live in a **private GitHub repository**. A free host rebuilds the site every time they change. The editor at **yoursite/admin** saves to GitHub using a personal key that only you have, so nobody else can change anything (the page is useless without your key, and search engines are told to ignore it).

### One-time setup (about 10 minutes)

1. **GitHub repository:** create a free account at github.com, then a new **private** repository (for example `my-website`). Leave it empty.
2. **Upload your files:** in this folder, run these commands one at a time. The first push opens a GitHub sign-in in your browser.
   ```bash
   git init -b main
   ```
   ```bash
   git add -A
   ```
   ```bash
   git commit -m "My website"
   ```
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/my-website.git
   ```
   ```bash
   git push -u origin main
   ```
3. **Host it (free):** pick one.
   - **Netlify:** Add new site → Import from Git → pick the repository. It reads `netlify.toml`, so just click Deploy.
   - **Cloudflare Pages:** Workers & Pages → Create → Pages → Connect to Git → pick the repository. Build command `node build.js`, output directory `dist`.
4. **Your editing key:** on GitHub open Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:
   - Repository access: **Only select repositories** → your site repository
   - Permissions → Repository permissions → **Contents: Read and write** (nothing else)
   - Pick an expiry date and generate. Copy the token (it starts with `github_pat_`).
5. **Sign in:** open `https://your-site-address/admin` on your phone, iPad or laptop and enter your repository (`your-username/my-website`), the branch `main` and the token. Tick "Remember on this device" on your own devices only.

### Using it

- **Saving:** every save is a commit on GitHub, so the full history is your backup and any change can be undone there. The live site updates about a minute after you save.
- **Signing out:** "Sign out of this device" in the editor removes the key from that browser.
- **Lost a device?** Delete the token on GitHub (Settings → Developer settings → Fine-grained tokens), and it stops working everywhere at once. Then make a new one.
- **On your computer:** `node build.js --dev` and `localhost:5500/admin` still work offline. Afterwards, upload your changes with `git add -A`, `git commit -m "update"` and `git push`. If you also edited online, run `git pull` first.

## Keyboard

There are no hints on screen: press `?` on any page to see this list.

| Key | Action |
| --- | --- |
| `1`–`6` | go to page |
| `←` `→` | previous / next page (or browse frames/images when the viewer is open) |
| `j` `k` | next / previous item |
| `Enter` | open item |
| `/` or `Ctrl`+`K` | search everything |
| `[` `]` | previous / next post |
| `b` / `Esc` | show / hide the post list |
| `g` `G` | top / bottom |

## Writing (English and Arabic)

Make one `.md` file per post in `content/posts/`:

```md
---
title: عنوان المقال
date: 2026-11-21
summary: One line for search engines.
lang: ar        # optional; detected automatically
---
```

- Arabic posts are right-to-left and use **Firjar**. Paragraphs in the other language inside a post switch direction on their own.
- Reading time is calculated automatically, in English or Arabic depending on the post.
- **Images and videos:** put files in `assets/posts/` and add them on their own line:
  - one image: `![caption](assets/posts/photo.jpg)` gives a full-width figure with a caption
  - two or three lines of images in a row give a gallery
  - a video: `![caption](assets/posts/clip.mp4)` gives a player with controls that loads only when needed
- Image sizes are read automatically, so pages don't jump while loading.

## Film diary (Shelf page)

In the editor, open **Movies**, pick a film and upload a **Frame**. You can also set **Watched on**, which groups the wall by year. In `content/site.json` that looks like:

```json
{ "title": "Past Lives", "year": 2023, "rating": 5, "watched": "2026-10-18", "frame": "assets/frames/past-lives.jpg" }
```

Frames appear as a wall grouped by year ("2026 film diary"). Click a frame or press Enter to open it big, then use `←` `→` or swipe to go through them.
Use .jpg or .webp files about 1600px wide; any aspect ratio works.

## Where everything is stored (the editor handles this for you)

| Page | Edit |
| --- | --- |
| Hey | `status` in `content/site.json`; the rows come from anything with `now: true` |
| Code | `projects` + screenshots in `assets/code/` |
| Design | `designs` + images in `assets/designs/` (opens in the viewer) |
| Shelf | `movies`, `games`, `books` |
| About | `about` (bio, Q&A, work) |
