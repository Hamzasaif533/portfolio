---
title: Hello, world
date: 2026-11-20
summary: Why I built this site from scratch, and how to write posts in English or Arabic.
---

dear reader,

welcome to my corner of the internet. this is where I'll write about the **movies**, **games** and **books** I can't stop thinking about, and whatever I'm building in code and Photoshop.

## writing a post

each post is a Markdown file in `content/posts/`. the top of the file looks like this:

```md
---
title: My post
date: 2026-11-20
summary: One line for search engines.
lang: en        # or ar (optional, it's detected automatically)
---
```

## images and videos

put files in `assets/posts/` and add them on their own line. one image becomes a full-width figure, and the text in the brackets becomes the caption:

![A frame I keep coming back to](assets/frames/blade-runner-2049.svg)

two or three images in a row become a gallery:

![](assets/frames/dune-part-two.svg)
![](assets/frames/interstellar.svg)
![](assets/frames/past-lives.svg)

videos use the same syntax, just with an `.mp4` or `.webm` file. they get play controls and only load when needed:

```md
![A short screen recording](assets/posts/demo.mp4)
```

## mixing languages

you can write a whole post in Arabic, or mix both. every paragraph picks its own direction:

هذه فقرة بالعربية داخل مقال إنجليزي، وتظهر من اليمين إلى اليسار بخط فرجار.

> press ? anywhere to see the keyboard shortcuts.
