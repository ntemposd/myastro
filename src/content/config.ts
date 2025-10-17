// src/content/config.ts
import { defineCollection, z } from 'astro:content';

const urlOrLocalPath = z.union([
  z.string().url(),
  z.string().regex(/^\/[A-Za-z0-9/_\-.]+$/), // e.g. /notion/posts/foo.webp
]);

const posts = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    excerpt: z.string().optional(),
    tags: z.array(z.string()).default([]),
    image: urlOrLocalPath.optional(),     // ⬅ allow local path
    draft: z.boolean().default(false),
    notionId: z.string(),
  }),
});

const projects = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    blurb: z.string(),
    tags: z.array(z.string()).default([]),
    link: z.string().url(),
    image: urlOrLocalPath.optional(),     // ⬅ allow local path
    order: z.number().default(0),
    draft: z.boolean().default(false),
    notionId: z.string().optional(),
  }),
});

const experience = defineCollection({
  type: 'data',
  schema: z.object({
    company: z.string(),
    role: z.string().optional(),
    start: z.string().nullable(),
    end: z.string().nullable().optional(),
    current: z.boolean().default(false),
    location: z.string().optional(),
    url: z.string().url().optional(),
    summary: z.string().optional(),
    tags: z.array(z.string()).default([]),
    order: z.number().default(0),
    logo: z.string().optional(),
  }),
});

export const collections = { posts, projects, experience };
