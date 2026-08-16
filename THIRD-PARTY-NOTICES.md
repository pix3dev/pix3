# Third-Party Notices

Pix3 ships and depends on the third-party components listed below. Each remains
under its own licence; nothing here modifies those terms.

Regenerate the inventory after changing dependencies:

```bash
npm run licenses:report
```

## Components

| Component | Version | Licence | Used by |
|---|---|---|---|
| [@dimforge/rapier3d](https://github.com/dimforge/rapier) | 0.19.3 | Apache-2.0 | editor |
| [@esotericsoftware/spine-threejs](https://github.com/EsotericSoftware/spine-runtimes) | 4.3.13 | Spine Runtimes License | editor, runtime (peer) |
| [@hocuspocus/provider](https://github.com/ueberdosis/hocuspocus) | 2.15.3 | MIT | editor |
| [@hocuspocus/server](https://github.com/ueberdosis/hocuspocus) | 3.4.4 | MIT | collab-server |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | 4.2.0 | Apache-2.0 | editor |
| [bcrypt](https://github.com/kelektiv/node.bcrypt.js) | 6.0.0 | MIT | collab-server |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 12.8.0 | MIT | collab-server |
| [cookie-parser](https://github.com/expressjs/cookie-parser) | 1.4.7 | MIT | collab-server |
| [cors](https://github.com/expressjs/cors) | 2.8.6 | MIT | collab-server |
| [dotenv](https://github.com/motdotla/dotenv) | 16.6.1 | BSD-2-Clause | collab-server |
| [esbuild-wasm](https://github.com/evanw/esbuild) | 0.24.0 | MIT | editor |
| [express](https://github.com/expressjs/express) | 4.22.2 | MIT | collab-server |
| [feather-icons](https://github.com/feathericons/feather) | 4.29.2 | MIT | editor |
| [golden-layout](https://github.com/golden-layout/golden-layout) | 2.6.0 | MIT | editor |
| [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) | 9.0.3 | MIT | collab-server |
| [jszip](https://github.com/Stuk/jszip) | 3.10.1 | MIT *(see note)* | editor |
| [lit](https://github.com/lit/lit) | 3.3.1 | BSD-3-Clause | editor |
| [monaco-editor](https://github.com/microsoft/monaco-editor) | 0.55.1 | MIT | editor |
| [multer](https://github.com/expressjs/multer) | 2.2.0 | MIT | collab-server |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.27.0 | MIT | editor |
| [postprocessing](https://github.com/pmndrs/postprocessing) | 6.39.2 | Zlib | editor, runtime (peer) |
| [qrcode](https://github.com/soldair/node-qrcode) | 1.5.4 | MIT | editor |
| [reflect-metadata](https://github.com/rbuckton/reflect-metadata) | 0.2.2 | Apache-2.0 | editor |
| [three](https://github.com/mrdoob/three.js) | 0.183.2 | MIT | editor, runtime (peer) |
| [valtio](https://github.com/pmndrs/valtio) | 2.1.8 | MIT | editor |
| [ws](https://github.com/websockets/ws) | 8.21.1 | MIT | collab-server |
| [yaml](https://github.com/eemeli/yaml) | 2.9.0 | ISC | editor, runtime |
| [yjs](https://github.com/yjs/yjs) | 13.6.30 | MIT | editor, collab-server |

## Machine-learning models

Model weights are **not** bundled — they download on first use — but they carry
their own licences, which are independent of the code that loads them.

| Model | Licence | Notes |
|---|---|---|
| [U²-Net](https://github.com/xuebinqin/U-2-Net) (`u2net`, `u2netp`) | Apache-2.0 | Default background-removal engine. Apache-2.0 covers both the code and the published checkpoints — verified against the upstream LICENSE. |
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) (ONNX exports) | MIT | Optional higher-quality engine; requires WebGPU. |

**Deliberately not used:** IS-Net / DIS. Its code is Apache-2.0, but upstream
publishes the pretrained checkpoints with no licence at all and the DIS5K
dataset carries separate terms. Silence is not a grant.

## Notes on specific components

### Attribution required (Apache-2.0)

`@dimforge/rapier3d`, `@huggingface/transformers` and `reflect-metadata` are
Apache-2.0 and require their licence and attribution notices to be preserved in
redistributions.

### jszip — dual-licensed

jszip is offered under `MIT OR GPL-3.0-or-later`. Pix3 elects the **MIT** option.
That election is recorded here deliberately: it is the licensee's choice to make,
and it needs to be on the record rather than inferred.

### Spine Runtimes — the user must hold their own licence

`@esotericsoftware/spine-threejs` is **not** open source. Its licence permits
integration into products provided that *each user of the product obtains their
own Spine Editor licence*, and that the licence and copyright notice travel with
any redistribution.

This is why Spine is an optional, host-injected dependency rather than a hard
one: the runtime never imports it (see
`packages/pix3-runtime/src/core/spine/spine-module.ts`), and it is only loaded
when a host registers a loader. Projects that do not use `SpineSkeleton2D` never
pull it in and take on no Spine obligation.

**If you use Spine features in Pix3, you must hold a valid Spine Editor licence.**

### postprocessing — Zlib

The Zlib licence is permissive and requires only that the origin not be
misrepresented and that altered source versions be marked as such.
