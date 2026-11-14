# Self-hosted fonts

`app/layout.tsx` loads these files with `next/font/local`, so a build never
downloads fonts from Google Fonts (owner decision, 2026-11-14). A failed
answer from Google used to fail the whole build.

The files are the ones `next/font/google` served for the layout's options on
2026-11-14 (Next.js 15.5.29). They were taken from that build's
`.next/static/media` and checked byte for byte against the same files
downloaded from fonts.gstatic.com (sha256 below).

## Why there is more than the latin subset

The layout asked `next/font/google` for `subsets: ["latin"]`. That option
chose only which files were preloaded. The CSS Google returned, which
`next/font/google` kept, also declared the faces for the other subsets
(latin-ext, cyrillic, greek, vietnamese; devanagari for Poppins; math and
symbols for Roboto; symbols2 for Geist Mono), each limited by
`unicode-range`. A browser downloads one of those files only when the page
has a character in its range: Inter draws ₹ from latin-ext, for example,
and Poppins draws Hindi from devanagari. All of them are kept so that pages
look the same as before.

## Families

| Family | Folder | Google Fonts version | Licence |
|---|---|---|---|
| Inter | `inter/` | v20 | SIL Open Font License 1.1, `inter/OFL.txt` |
| Poppins | `poppins/` | v24 | SIL Open Font License 1.1, `poppins/OFL.txt` |
| Plus Jakarta Sans | `plus-jakarta-sans/` | v12 | SIL Open Font License 1.1, `plus-jakarta-sans/OFL.txt` |
| Roboto | `roboto/` | v51 | SIL Open Font License 1.1, `roboto/OFL.txt` |
| Merriweather | `merriweather/` | v33 | SIL Open Font License 1.1, `merriweather/OFL.txt` (Reserved Font Name "Merriweather") |
| Geist Mono | `geist-mono/` | v6 | SIL Open Font License 1.1, `geist-mono/OFL.txt` |

Each `OFL.txt` is the family's licence file from the google/fonts repository,
`https://github.com/google/fonts/blob/main/ofl/<folder>/OFL.txt`, where the
folder is `inter`, `poppins`, `plusjakartasans`, `roboto`, `merriweather` or
`geistmono`.

`fallbacks.css` holds the six fallback faces (`Inter Fallback` and so on)
with the metrics `next/font/google` generated for these families.

The decision and its limits are recorded in
`docs/adr/0025-self-hosted-fonts.md`.

## One family, several calls: what this relies on

Each family is split over several `localFont` calls, one per subset, and
every call declares the same `font-family` (`Inter`, `Poppins` and so on).
That works only because `next/font` keeps a declared family name as it is,
so all the faces of a family end up under one name, the one its CSS variable
points at. Next 15.5 does this with webpack, which `npm run build` and
`npm run dev` use. Next 14.2 did not: it renamed the family per call
(`'__Inter_<hash>'`), and `next/font`'s own comments still describe that
renaming. If that behaviour came back, only the latin faces would apply; the
rupee sign in Inter (latin-ext) and Hindi in Poppins (devanagari) would fall
back to another font, with no error.

`scripts/check-built-fonts.mjs` guards this. It runs after the build in the
pull request e2e job (`scripts/e2e-in-runner.sh`) and fails unless the built
CSS has the 83 `url()` faces under exactly the six family names, the six
fallback faces and the six variables. To run it by hand after a build:
`node scripts/check-built-fonts.mjs` (or pass the build folder). Run it, and
compare a page's fonts before and after, on any Next upgrade and before any
move to Turbopack, which has not been checked.

## Changing the set

Take new files the same way (a `next/font/google` build, or the Google Fonts
CSS2 API with the same parameters), add one `localFont` call per subset in
`app/layout.tsx`, and add each file to the table below. Then update the
expected values in `tests/unit/self-hosted-fonts.test.ts` (the subset
ranges, the families and the fallback metrics) and `EXPECTED_FACES` in
`scripts/check-built-fonts.mjs`. The unit test checks every file against this
table and the layout against those values.

## Files

`-var` files are variable fonts. Roboto and Merriweather use one variable
file per subset, declared at each weight the layout asks for, as Google's CSS
did.

| File | Subset | Weight | Bytes | SHA-256 | Served from |
|---|---|---|---|---|---|
| inter/inter-cyrillic-ext-var.woff2 | cyrillic-ext | 100 900 | 25844 | fccca918fea40089dacadc7045861314d1a6bc91f1f323cc1eeb22ebcdb321b5 | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2JL7W0Q5n-wU.woff2 |
| inter/inter-cyrillic-var.woff2 | cyrillic | 100 900 | 18744 | aebf2ab4a4ce6810d73c1ac7be7cafb4e5ec4cee2d6db5fb3e09691747ec4bd6 | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa0ZL7W0Q5n-wU.woff2 |
| inter/inter-greek-ext-var.woff2 | greek-ext | 100 900 | 11272 | a2e2c783ca6f9c20486e81e72a279203e86730bbf8f01ff6a5ee9dbd09e1c271 | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2ZL7W0Q5n-wU.woff2 |
| inter/inter-greek-var.woff2 | greek | 100 900 | 19044 | 46dd4cdca58c26ae87cc6927657bf83b2e8abfc39ffd0ab176e301a8d28d22bf | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1pL7W0Q5n-wU.woff2 |
| inter/inter-vietnamese-var.woff2 | vietnamese | 100 900 | 10280 | 8db00ff46c67b22cda8bed865acf7077651cac8d2841d5b40980556b48961931 | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa2pL7W0Q5n-wU.woff2 |
| inter/inter-latin-ext-var.woff2 | latin-ext | 100 900 | 85272 | a28eb6d3ccb534ae0c94ca999371df024aab60b08c3c8a5720ee9e32fa0faaa2 | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa25L7W0Q5n-wU.woff2 |
| inter/inter-latin-var.woff2 | latin | 100 900 | 48432 | c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4 | fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2 |
| poppins/poppins-devanagari-300.woff2 | devanagari | 300 | 39416 | f019bf8fa642981b9f12647688e825ccad3522d51f2f2859b1af372d5dc1ac31 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLDz8Z11lFd2JQEl8qw.woff2 |
| poppins/poppins-devanagari-400.woff2 | devanagari | 400 | 39504 | 23617a1bf667dd6a29e2724ac6595e75924549d1c25e8672e2346ef38bc9984a | fonts.gstatic.com/s/poppins/v24/pxiEyp8kv8JHgFVrJJbecnFHGPezSQ.woff2 |
| poppins/poppins-devanagari-500.woff2 | devanagari | 500 | 39160 | 9c8c47ee0aeaa2d378f4e5d5719ecbf05a601a35c285d0d48b888106bb15cf49 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLGT9Z11lFd2JQEl8qw.woff2 |
| poppins/poppins-devanagari-600.woff2 | devanagari | 600 | 39384 | 6d8ef422be4d827037f6f2d5766a0808018876fa5e9aa9a92787fad9d1f17938 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLEj6Z11lFd2JQEl8qw.woff2 |
| poppins/poppins-devanagari-700.woff2 | devanagari | 700 | 39204 | 6eb8802d7319fcd48850eb38e41ed6ea12d917faafdfac7dae5614a517dc2b54 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLCz7Z11lFd2JQEl8qw.woff2 |
| poppins/poppins-latin-ext-300.woff2 | latin-ext | 300 | 5540 | c2857fb5c3f971df45e8c2764709acbcc5c6d60b9e47d945ae2e7bc51415afeb | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLDz8Z1JlFd2JQEl8qw.woff2 |
| poppins/poppins-latin-ext-400.woff2 | latin-ext | 400 | 5640 | 1fae5e73d2788ee1dea1d76eca3a9f157a0386de6be8c280d076a53a64c358a1 | fonts.gstatic.com/s/poppins/v24/pxiEyp8kv8JHgFVrJJnecnFHGPezSQ.woff2 |
| poppins/poppins-latin-ext-500.woff2 | latin-ext | 500 | 5496 | f8f0c28661c88edbcee022a4a80657619e8931af8c2a47c28e230307e2af30e5 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLGT9Z1JlFd2JQEl8qw.woff2 |
| poppins/poppins-latin-ext-600.woff2 | latin-ext | 600 | 5552 | 72efc6a32cfd37c557108628cffa01153c480c3d4cde556744406e50b9d8e9f7 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLEj6Z1JlFd2JQEl8qw.woff2 |
| poppins/poppins-latin-ext-700.woff2 | latin-ext | 700 | 5448 | 2477683a4b1200680780a759cc1b93b816410362dc5f4c74ebfeafa212bcb74d | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLCz7Z1JlFd2JQEl8qw.woff2 |
| poppins/poppins-latin-300.woff2 | latin | 300 | 7844 | 643e38d8c288a1da34a14a68a5012441929108d50054414ce8cc33fad36a2354 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLDz8Z1xlFd2JQEk.woff2 |
| poppins/poppins-latin-400.woff2 | latin | 400 | 7900 | 3dc5d0c52428fe1696264907a1054ebbaac07f8cbe45832c105f819c2ae397c0 | fonts.gstatic.com/s/poppins/v24/pxiEyp8kv8JHgFVrJJfecnFHGPc.woff2 |
| poppins/poppins-latin-500.woff2 | latin | 500 | 7740 | 289e0afc8be731a86822349e54557296f145926496bd2138db1bac0db77f77a2 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLGT9Z1xlFd2JQEk.woff2 |
| poppins/poppins-latin-600.woff2 | latin | 600 | 7992 | 872e862918591a9e824dc03ed92f05729435ffbb8ebbb10eff7eda26592b1798 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLEj6Z1xlFd2JQEk.woff2 |
| poppins/poppins-latin-700.woff2 | latin | 700 | 7848 | 197a3cbd7290c242c5c765268cdd69a9a39867fdc80cd13071f243a81c56fb76 | fonts.gstatic.com/s/poppins/v24/pxiByp8kv8JHgFVrLCz7Z1xlFd2JQEk.woff2 |
| plus-jakarta-sans/plus-jakarta-sans-cyrillic-ext-var.woff2 | cyrillic-ext | 200 800 | 1716 | a16f29d7d2a21a4f9b3249a82eb2725ed5bdb91500dfb5c4758977de27477f20 | fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko70yygg_vbd-E.woff2 |
| plus-jakarta-sans/plus-jakarta-sans-vietnamese-var.woff2 | vietnamese | 200 800 | 8292 | 5c913fc1b1f86f4b475e5df45a796aa480d1f7f0891ed6f1a5991d6d1be887c3 | fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko50yygg_vbd-E.woff2 |
| plus-jakarta-sans/plus-jakarta-sans-latin-ext-var.woff2 | latin-ext | 200 800 | 21688 | 0303e02b53b0298fb26a0193941a2e8754f0f9a9fce50d90b178d8da3424873f | fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko40yygg_vbd-E.woff2 |
| plus-jakarta-sans/plus-jakarta-sans-latin-var.woff2 | latin | 200 800 | 27272 | cd8db90cd950e26bc8761f65d323588bd5cd112d326d6d322bc7c8ea86771215 | fonts.gstatic.com/s/plusjakartasans/v12/LDIoaomQNQcsA88c7O9yZ4KMCoOg4Ko20yygg_vb.woff2 |
| roboto/roboto-cyrillic-ext-var.woff2 | cyrillic-ext | 300, 400, 500, 700 | 31472 | e44224eb71a96cb33bd046ded16a4e22bb441b170bdfbcba0268a754141b97c8 | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3GUBHMdazTgWw.woff2 |
| roboto/roboto-cyrillic-var.woff2 | cyrillic | 300, 400, 500, 700 | 19624 | 32886c5ec61a0d06e5677a98c5ed78a5f1c788c18c5e8d7dcd931c4b6dc19830 | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3iUBHMdazTgWw.woff2 |
| roboto/roboto-greek-ext-var.woff2 | greek-ext | 300, 400, 500, 700 | 1632 | 5fdfeaf926cac990770dfa66011bdb87d6b69f43c42aa759dcdcf0a7a197c19a | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3CUBHMdazTgWw.woff2 |
| roboto/roboto-greek-var.woff2 | greek | 300, 400, 500, 700 | 13984 | 4813e3dfbbb23708c817ef7fd3fd9c82cd0d33c778def0897f0447f1c364ce64 | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3-UBHMdazTgWw.woff2 |
| roboto/roboto-math-var.woff2 | math | 300, 400, 500, 700 | 36292 | 297193369eea600161f4b5219bd7b08850180fcfe0752f1a2eaa436575cd03b7 | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMawCUBHMdazTgWw.woff2 |
| roboto/roboto-symbols-var.woff2 | symbols | 300, 400, 500, 700 | 16692 | fab8a0056d92fdd8d64fed4b049744144e1d24d08762c513bff78265299ed7a3 | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMaxKUBHMdazTgWw.woff2 |
| roboto/roboto-vietnamese-var.woff2 | vietnamese | 300, 400, 500, 700 | 10572 | 2071148c26bd0430cad316373c26db399e0cf8f6275b9e1a2c1b831f05ee7dc3 | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3OUBHMdazTgWw.woff2 |
| roboto/roboto-latin-ext-var.woff2 | latin-ext | 300, 400, 500, 700 | 24444 | cdd53dc5576a79f35cf280dfbd9c1cb2a5dd2f0ede30afba9b9ccdc7fe12e7d0 | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3KUBHMdazTgWw.woff2 |
| roboto/roboto-latin-var.woff2 | latin | 300, 400, 500, 700 | 37520 | 0a44e0bb6ba5c8537e8814c148ef7755f1bce12112361231f595ecc584a18d7a | fonts.gstatic.com/s/roboto/v51/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBHMdazQ.woff2 |
| merriweather/merriweather-cyrillic-ext-var.woff2 | cyrillic-ext | 300, 400, 700 | 33792 | 7e1822475854e1dee82df16f836b79a59c6630d350b781970c8be782b8793db8 | fonts.gstatic.com/s/merriweather/v33/u-4e0qyriQwlOrhSvowK_l5UcA6zuSYEqOzpPe3HOZJ5eX1WtLaQwmYiSeqnJ-mXq1Gi3iE.woff2 |
| merriweather/merriweather-cyrillic-var.woff2 | cyrillic | 300, 400, 700 | 51604 | ed391ae49db1a5c477ed280eb6411b4df5ae83324c90fd695f5e1b7331a9cae0 | fonts.gstatic.com/s/merriweather/v33/u-4e0qyriQwlOrhSvowK_l5UcA6zuSYEqOzpPe3HOZJ5eX1WtLaQwmYiSequJ-mXq1Gi3iE.woff2 |
| merriweather/merriweather-vietnamese-var.woff2 | vietnamese | 300, 400, 700 | 10872 | 53049794c25af8b4a5e2b4b9c2345c47b8f0fdc65ec6e93b18fea74eae2ce956 | fonts.gstatic.com/s/merriweather/v33/u-4e0qyriQwlOrhSvowK_l5UcA6zuSYEqOzpPe3HOZJ5eX1WtLaQwmYiSeqlJ-mXq1Gi3iE.woff2 |
| merriweather/merriweather-latin-ext-var.woff2 | latin-ext | 300, 400, 700 | 74940 | f66e5c1890094c8a646b74a27fbd8f15e748003c43575a5ea18b726a7727349f | fonts.gstatic.com/s/merriweather/v33/u-4e0qyriQwlOrhSvowK_l5UcA6zuSYEqOzpPe3HOZJ5eX1WtLaQwmYiSeqkJ-mXq1Gi3iE.woff2 |
| merriweather/merriweather-latin-var.woff2 | latin | 300, 400, 700 | 97608 | af1be39e2ff60ede976bc3a93b9aceb3ac7103207b21a62d1971e3ea8cf95b97 | fonts.gstatic.com/s/merriweather/v33/u-4e0qyriQwlOrhSvowK_l5UcA6zuSYEqOzpPe3HOZJ5eX1WtLaQwmYiSeqqJ-mXq1Gi.woff2 |
| geist-mono/geist-mono-cyrillic-ext-var.woff2 | cyrillic-ext | 100 900 | 6204 | e27f657e38d52887baa3b6b2f812bef93dfdd356f0810e40edd4ee284cc7e9f6 | fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrodmhHkjkotbA.woff2 |
| geist-mono/geist-mono-cyrillic-var.woff2 | cyrillic | 100 900 | 12872 | 75b3bedbebc35f347c0ae3b416aa871941555357e7b0f83767eb5987875589ed | fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrMdmhHkjkotbA.woff2 |
| geist-mono/geist-mono-symbols2-var.woff2 | symbols2 | 100 900 | 5892 | d67e4a94ba498635f764ddca7d1ec4271f5642f032eb24b426764480f66f8497 | fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFg08vz7MhEIVVeA.woff2 |
| geist-mono/geist-mono-vietnamese-var.woff2 | vietnamese | 100 900 | 7728 | 16e1d48b6dd29eb240aec5db36184eb182933c082cd43de7f35af686d58087d2 | fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrgdmhHkjkotbA.woff2 |
| geist-mono/geist-mono-latin-ext-var.woff2 | latin-ext | 100 900 | 14712 | 745994b5cd950ec201b66526375f057d540847cccfc70f4f24f5f571d26d3923 | fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrkdmhHkjkotbA.woff2 |
| geist-mono/geist-mono-latin-var.woff2 | latin | 100 900 | 23108 | 5f3d6ad60f29d6cb708414ec6887163d63bf197377ef5417d2483ff31ace6c3b | fonts.gstatic.com/s/geistmono/v6/or3nQ6H-1_WfwkMZI_qYFrcdmhHkjko.woff2 |
