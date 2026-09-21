# OneDrive If-Match 并发保护 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 OneDrive 写入点加 `If-Match` etag 预检,412 时导流到已有的 smart_conflict 合并/`.dup` 路径并通知用户,消除两台设备并发写同一文件时的静默丢数据。

**Architecture:** 上传请求带 walk 时远端 etag,OneDrive 原子核对(匹配→写入轮转新 etag;不匹配→412 不写入)。412 经 `remoteEtagMismatchError`(镜像现有 `remoteNotFoundError` 的 `.code` 模式)向上抛,在 `sync.ts` push 分支 try/catch 拦截后改走 `conflict_modified_then_smart_conflict`(复用现有 `mergeFile`/`tryDuplicateFile`,不另写备份逻辑),并触发 Notice + 冲突日志。

**Tech Stack:** TypeScript + esbuild;Obsidian Plugin API(`Notice`/`Vault.adapter`);Microsoft Graph App Folder(`createUploadSession`/`PUT :/content`/`PATCH`);mocha + tsx 手搓 mock 测试(无 fetch mock 基建)。

**Spec:** `docs/superpowers/specs/2026-09-20-onedrive-if-match-concurrency-guard-design.md`

## Global Constraints

- Biome 风格:2 空格缩进、LF、80 列、双引号、分号、`es5` 尾逗号。**`noExplicitAny`/`noNonNullAssertion` 等默认 OFF——不要"修" `any`/非空断言。**
- 版本同步:`package.json`、`manifest.json`、`manifest-beta.json` 三处版本号保持一致。
- PolyForm Strict 1.0.0 文件(`src/sync.ts`、`src/conflictLogic.ts`、`src/fileContentHistory.ts`、`src/clearDupFiles.ts`、`src/settingsClearDupFiles.ts`)改动须尊重许可证;PR 按 `CONTRIBUTING.md`/`CLA.md` 签 CLA。
- 测试约定:测试文件首行 `import "./_globalsSetup";`;断言用 `import { strict as assert } from "assert"`;跑 `npm test` 或单文件 `npx mocha --import=tsx tests/<name>.test.ts`;类型 `npm run typecheck`;格式 `npm run format`。
- 错误跨层形态:plain `Error` + 挂 `(err as any).code` + `(err as any).key`;`makeCatch`(`sync.ts:1934-1949`)保留之,`main.ts` errNotifyFunc 按 `.code` 分流。
- 调用方式契约重审(AGENTS.md):改写入调用方式后,重读 `createUploadSession`/`PUT :/content`/`PATCH` 的 Remarks,确认 412 响应体在新模式下仍保证返回(Task 10/收尾)。

---

## File Structure

| 文件 | 改动 | 责任 |
|---|---|---|
| `src/driveItemConvert.ts` | 改 `fromDriveItemToEntity` | 映射 `driveItem.eTag` → `Entity.etag`(死代码接通) |
| `src/fsOnedrive.ts` | 新增 helper + 改 4 个写方法 | `remoteEtagMismatchError`/`classifyOneDriveWriteError`;`_putArrayBuffer`/`_postJson`(createUploadSession)/`_putUint8ArrayByRange`/`_patchJson` 捕获 412 转 `REMOTE_ETAG_MISMATCH`;写入加 `If-Match` 头 |
| `src/fsAll.ts` | 改 `FakeFs.writeFile` 签名 | 加可选 `expectedEtag?: string` |
| `src/fsLocal.ts`、`src/fsEncrypt.ts` | 透传 | `fsLocal` 忽略;`fsEncrypt` 透传给 `innerFs` |
| `src/copyLogic.ts` | 改 `copyFile`/`copyFileOrFolder` 签名 | 加可选 `expectedEtag?: string` 透传 |
| `src/sync.ts` | 抽函数 + 改 push 分支 | 抽 `handleConflictModifiedSmartConflict`;push 分支 try/catch `REMOTE_ETAG_MISMATCH` → 调抽出的函数;传 `r.remote?.etag` |
| `src/main.ts` | 改 `errNotifyFunc` + 新增日志 | `REMOTE_ETAG_MISMATCH` 分支 Notice + append 冲突日志;日志文件加 sync ignore |
| `src/baseTypes.ts` | (可能)新增 ignore 默认项 | 冲突日志文件名进默认 ignore 列表 |
| `tests/syncDispatchIfMatch.test.ts` | 新建 | mock FakeFs `writeFile` 抛 `REMOTE_ETAG_MISMATCH`,验证 re-route 到 `mergeFile`/`tryDuplicateFile` |
| `tests/driveItemConvert.test.ts` | 扩 | etag 映射断言 |
| `tests/onedriveHttpError.test.ts` | 新建 | `classifyOneDriveWriteError` 纯函数 |
| `tests/syncDispatchIfMatch.test.ts` | 新建 | re-route 行为 |
| `docs/remote_services/onedrive/concurrency.md` | 新建 | OneDrive 并发机制 reference |

---

## Task 1: 接通 `fromDriveItemToEntity` 的 etag 映射

**Files:**
- Modify: `src/driveItemConvert.ts:326-356`(`fromDriveItemToEntity` 返回对象)
- Test: `tests/driveItemConvert.test.ts`(已存在,扩一条断言)

**Interfaces:**
- Consumes: `DriveItem.eTag`(`string | undefined`,Graph 返回)
- Produces: `Entity.etag` 现被填充(`string | undefined`),后续 Task 3/4/6 依赖此字段穿透到 `r.remote.etag` 与 `prevSync.etag`

- [ ] **Step 1: 写失败测试**

在 `tests/driveItemConvert.test.ts` 末尾新增(复用该文件已有的 `fromDriveItemToEntity` import 与 DriveItem 构造模式):

```ts
it("maps driveItem.eTag onto Entity.etag", () => {
  const driveItem = {
    name: "a.md",
    size: 10,
    file: {},
    fileSystemInfo: { lastModifiedDateTime: "2024-01-01T00:00:00Z", createdDateTime: "2024-01-01T00:00:00Z" },
    parentReference: { path: "/drive/root:/Apps/remotely-save:/vault", name: "vault" },
    eTag: '"012345819293.1"',
  };
  const e = fromDriveItemToEntity(driveItem as any, "/Apps/remotely-save/vault");
  assert.strictEqual(e.etag, '"012345819293.1"');
});
```

- [ ] **Step 2: 跑确认失败**

```bash
npx mocha --import=tsx tests/driveItemConvert.test.ts
```
Expected: FAIL,`e.etag` 为 `undefined`(断言不等)。

- [ ] **Step 3: 最小实现**

`src/driveItemConvert.ts` 返回对象(`:326-356` 末尾的 return)加一行:

```ts
  return {
    key, keyRaw: key,
    mtimeSvr, mtimeCli, ctimeCli,
    size: isFolder ? 0 : x.size!,
    sizeRaw: isFolder ? 0 : x.size!,
    synthesizedFile: false,
    etag: x.eTag,            // ← 新增
  };
```

- [ ] **Step 4: 跑确认通过**

```bash
npx mocha --import=tsx tests/driveItemConvert.test.ts
```
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/driveItemConvert.ts tests/driveItemConvert.test.ts
git commit -m "feat(onedrive): map driveItem.eTag onto Entity.etag in fromDriveItemToEntity"
```

---

## Task 2: `remoteEtagMismatchError` + `classifyOneDriveWriteError` 纯函数

**Files:**
- Modify: `src/fsOnedrive.ts:58-101`(已有 `isHttp404`/`extractHttpStatus`/`remoteNotFoundError` 同区)
- Test: `tests/onedriveHttpError.test.ts`(新建)

**Interfaces:**
- Produces: `remoteEtagMismatchError(key: string): Error`(`.code === "REMOTE_ETAG_MISMATCH"`、`.key`,镜像 `remoteNotFoundError` `:94-101`);`classifyOneDriveWriteError(e: any): "REMOTE_ETAG_MISMATCH" | "REMOTE_NOT_FOUND" | null`(纯函数,供 Task 4/5 的写方法与 Task 6 上层共用)

- [ ] **Step 1: 写失败测试**

新建 `tests/onedriveHttpError.test.ts`:

```ts
import "./_globalsSetup";
import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { remoteEtagMismatchError, classifyOneDriveWriteError } from "../src/fsOnedrive";

describe("onedrive write-error classification", () => {
  it("remoteEtagMismatchError sets code+key", () => {
    const e = remoteEtagMismatchError("vault/a.md");
    assert.strictEqual((e as any).code, "REMOTE_ETAG_MISMATCH");
    assert.strictEqual((e as any).key, "vault/a.md");
    assert.match(e.message, /a\.md/);
  });

  it("classify: fetch 412 Error message → REMOTE_ETAG_MISMATCH", () => {
    const e = new Error("OneDrive PUT failed: 412 https://graph/... {\"error\":{...}}");
    assert.strictEqual(classifyOneDriveWriteError(e), "REMOTE_ETAG_MISMATCH");
  });

  it("classify: {status:412} object → REMOTE_ETAG_MISMATCH", () => {
    assert.strictEqual(classifyOneDriveWriteError({ status: 412 }), "REMOTE_ETAG_MISMATCH");
  });

  it("classify: Obsidian request 412 ('Request failed, status 412') → REMOTE_ETAG_MISMATCH", () => {
    const e = new Error("Request failed, status 412");
    assert.strictEqual(classifyOneDriveWriteError(e), "REMOTE_ETAG_MISMATCH");
  });

  it("classify: 404 → REMOTE_NOT_FOUND", () => {
    assert.strictEqual(classifyOneDriveWriteError({ status: 404 }), "REMOTE_NOT_FOUND");
    assert.strictEqual(classifyOneDriveWriteError(new Error("status 404")), "REMOTE_NOT_FOUND");
  });

  it("classify: 429/500/other → null (not a write-conflict signal)", () => {
    assert.strictEqual(classifyOneDriveWriteError({ status: 429 }), null);
    assert.strictEqual(classifyOneDriveWriteError(new Error("boom")), null);
    assert.strictEqual(classifyOneDriveWriteError(undefined), null);
  });
});
```

- [ ] **Step 2: 跑确认失败**

```bash
npx mocha --import=tsx tests/onedriveHttpError.test.ts
```
Expected: FAIL(导出名不存在)。

- [ ] **Step 3: 实现**

在 `src/fsOnedrive.ts` `remoteNotFoundError`(`:94-101`)旁新增,并 export:

```ts
export function remoteEtagMismatchError(key: string): Error {
  const err = new Error(
    `Remote etag mismatch (another device changed this file since sync walk): ${key}`
  );
  (err as any).code = "REMOTE_ETAG_MISMATCH";
  (err as any).key = key;
  return err;
}

export function classifyOneDriveWriteError(e: any): "REMOTE_ETAG_MISMATCH" | "REMOTE_NOT_FOUND" | null {
  const status = extractHttpStatus(e);
  if (status === 412) return "REMOTE_ETAG_MISMATCH";
  if (status === 404) return "REMOTE_NOT_FOUND";
  return null;
}
```

> 复用现有 `extractHttpStatus`(`:74-87`,已能从 `.status`/`.response.status`/`message` 解析 3 位状态码)。

- [ ] **Step 4: 跑确认通过**

```bash
npx mocha --import=tsx tests/onedriveHttpError.test.ts
```
Expected: PASS。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/fsOnedrive.ts tests/onedriveHttpError.test.ts
git commit -m "feat(onedrive): add remoteEtagMismatchError + classifyOneDriveWriteError for 412/404"
```

---

## Task 3: `FakeFs.writeFile` 透传链加 `expectedEtag`

> 纯签名透传,行为不变(还没真用 If-Match)。目标:让 `r.remote.etag` 能从 sync.ts 一路传到 `fsOnedrive._writeFileFromRoot`。全程跑全测试套不破即可。

**Files:**
- Modify: `src/fsAll.ts:5-113`(`FakeFs.writeFile` 抽象签名)
- Modify: `src/fsLocal.ts`(`writeFile` 实现,忽略新参数)
- Modify: `src/fsEncrypt.ts:297-339`(`writeFile` 透传 `innerFs`)
- Modify: `src/copyLogic.ts:15-65`(`copyFile`/`copyFileOrFolder` 加参数)
- Modify: `src/sync.ts:1562-1595`(push 分支传 `r.remote?.etag`)
- Modify: `src/fsOnedrive.ts:973-1069`(`writeFile`/`_writeFileFromRoot` 接收,暂存但不发头——Task 4 才发)

**Interfaces:**
- `FakeFs.writeFile(key, content: ArrayBuffer, mtime: number, ctime: number, expectedEtag?: string): Promise<Entity>`
- `copyFileOrFolder(key, left: FakeFs, right: FakeFs, expectedEtag?: string)`
- `copyFile(key, left, right, expectedEtag?)`
- `_writeFileFromRoot(key, content, mtime, ctime, origKey, emptyFile, expectedEtag?)` — Task 4 用它发 If-Match

- [ ] **Step 1: 跑全测试套基线(确认改造前绿)**

```bash
npm test
```
Expected: 全绿(记录通过数作回归基线)。

- [ ] **Step 2: 改签名(逐文件加可选参数)**

`src/fsAll.ts` 抽象方法:
```ts
abstract writeFile(
  key: string, content: ArrayBuffer, mtime: number, ctime: number,
  expectedEtag?: string
): Promise<Entity>;
```

`src/fsLocal.ts` 实现:签名加 `expectedEtag?: string`,函数体不动(本地无 etag)。

`src/fsEncrypt.ts:297-339` `writeFile`:加参数并透传:
```ts
async writeFile(key: string, content: ArrayBuffer, mtime: number, ctime: number, expectedEtag?: string) {
  // ...现有加密逻辑,innerFs.writeFile(keyEnc, content, mtime, ctime, expectedEtag)
}
```

`src/copyLogic.ts` `copyFile`(`:15-53`)与 `copyFileOrFolder`(`:55-65`):加 `expectedEtag?: string` 参数,在 `right.writeFile(key, content, mtimeCli, ctimeCli, expectedEtag)` 处透传。

`src/fsOnedrive.ts` `writeFile`(`:973-1001`)与 `_writeFileFromRoot`(`:1003-1069`):签名加 `expectedEtag?: string`,**暂存字段不发头**(Task 4 发)。

`src/sync.ts:1571`(push 分支):
```ts
const { entity, content } = await copyFileOrFolder(r.key, fsLocal, fsEncrypt, r.remote?.etag);
```

- [ ] **Step 3: typecheck + 全测试套**

```bash
npm run typecheck
npm test
```
Expected: typecheck 通过;测试数与基线一致全绿(签名透传不改变行为)。

- [ ] **Step 4: commit**

```bash
git add src/fsAll.ts src/fsLocal.ts src/fsEncrypt.ts src/copyLogic.ts src/fsOnedrive.ts src/sync.ts
git commit -m "refactor(fs): thread expectedEtag through FakeFs.writeFile -> copyLogic -> sync push"
```

---

## Task 4: 小文件 `PUT :/content` 加 `If-Match` + 412 转 `REMOTE_ETAG_MISMATCH`

> HTTP 层无 fetch mock——纯函数部分(Task 2)已测;本任务的 412 转换逻辑靠 Task 2 的 `classifyOneDriveWriteError` 兜底,真实 412 由 Task 10 手动验证。这里只保证:带 `expectedEtag` 时发 `If-Match` 头,且 412 被转为带 `.code` 的 error。

**Files:**
- Modify: `src/fsOnedrive.ts:629-670`(`_putArrayBuffer` 加可选 `ifMatch` + key,412 转)
- Modify: `src/fsOnedrive.ts:1003-1069`(`_writeFileFromRoot` 小文件分支传 `expectedEtag`→`ifMatch`)

**Interfaces:**
- Consumes: Task 2 的 `remoteEtagMismatchError`/`classifyOneDriveWriteError`;Task 3 的 `expectedEtag` 参数
- Produces: 小文件 PUT 在 `expectedEtag` 存在时带 `If-Match`,412 抛 `REMOTE_ETAG_MISMATCH`

- [ ] **Step 1: 写测试(纯逻辑:带 ifMatch 时调用 fetch 的 headers 含 If-Match)**

> 无 fetch mock 基建,用 ts-sinon/undici 引入会过重。改用最小可行:把"构造请求"与"发请求"拆开——抽 `_buildPutRequest(url, payload, ifMatch?)` 纯函数返回 `{url, method, body, headers}`,单测它;`_putArrayBuffer` 调它再 fetch。

新建 `tests/onedrivePutRequest.test.ts`:

```ts
import "./_globalsSetup";
import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { _buildPutRequest } from "../src/fsOnedrive";

describe("onedrive PUT request builder", () => {
  it("without ifMatch: no If-Match header", () => {
    const r = _buildPutRequest("https://graph/x:/content", new ArrayBuffer(1));
    assert.ok(!("If-Match" in r.headers));
  });
  it("with ifMatch: sets If-Match header verbatim", () => {
    const r = _buildPutRequest("https://graph/x:/content", new ArrayBuffer(1), '"v1"');
    assert.strictEqual(r.headers["If-Match"], '"v1"');
  });
});
```

- [ ] **Step 2: 跑确认失败**

```bash
npx mocha --import=tsx tests/onedrivePutRequest.test.ts
```
Expected: FAIL(`_buildPutRequest` 未导出)。

- [ ] **Step 3: 实现**

`src/fsOnedrive.ts` 新增 export 纯函数 + 改 `_putArrayBuffer`:

```ts
export function _buildPutRequest(url: string, payload: ArrayBuffer, ifMatch?: string) {
  const headers: Record<string, string> = {
    "Content-Type": DEFAULT_CONTENT_TYPE,
    Authorization: "",  // 运行时由调用方填,这里只测结构
  };
  if (ifMatch !== undefined && ifMatch !== "") {
    headers["If-Match"] = ifMatch;
  }
  return { url, method: "PUT", body: payload, headers };
}
```

改 `_putArrayBuffer`(`:629-670`)签名加 `ifMatch?: string`、`key?: string`,在 fetch 前用 `_buildPutRequest` 取 headers(运行时 Authorization 用 `await this.authGetter.getAccessToken()` 覆盖),并在 `!res.ok` 分支加 412 转换:

```ts
async _putArrayBuffer(theUrl: string, payload: ArrayBuffer, ifMatch?: string, key?: string): Promise<DriveItem | UploadSession> {
  const req = _buildPutRequest(theUrl, payload, ifMatch);
  req.headers.Authorization = `Bearer ${await this.authGetter.getAccessToken()}`;
  const res = await fetch(theUrl, { method: "PUT", body: payload, headers: req.headers });
  if (res.status === 429) { throw { status: 429, headers: res.headers } as any; }
  if (res.status === 412 && key !== undefined) { throw remoteEtagMismatchError(key); }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OneDrive PUT failed: ${res.status} ${theUrl} ${body}`);
  }
  return (await res.json()) as DriveItem | UploadSession;
}
```

改 `_writeFileFromRoot` 小文件分支(`:1041-1046`)传 `ifMatch`+`origKey`:

```ts
driveItem = await this._putArrayBuffer(
  `${key}:/content?${new URLSearchParams({ "@microsoft.graph.conflictBehavior": "replace" })}`,
  content,
  expectedEtag,
  origKey,
);
```

- [ ] **Step 4: 跑确认通过 + 全套**

```bash
npx mocha --import=tsx tests/onedrivePutRequest.test.ts
npm test
```
Expected: 新测试 PASS;全套不回归。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/fsOnedrive.ts tests/onedrivePutRequest.test.ts
git commit -m "feat(onedrive): small-file PUT sends If-Match + converts 412 to REMOTE_ETAG_MISMATCH"
```

---

## Task 5: 大文件 `createUploadSession` + 分片加 `If-Match`/412 转

**Files:**
- Modify: `src/fsOnedrive.ts:1074-1099`(createUploadSession POST 加 `If-Match`)
- Modify: `src/fsOnedrive.ts:680-738`(`_putUint8ArrayByRange` 412 转)
- Modify: `src/fsOnedrive.ts:563-579`(`_patchJson` 412 转,小文件 mtime PATCH)

**Interfaces:**
- Consumes: Task 2 helpers、Task 3 `expectedEtag`
- Produces: createUploadSession 创建时带 `If-Match`(文档明确支持);分片 412 转;mtime PATCH 412 转

- [ ] **Step 1: 测试(createUploadSession 请求体构造纯函数)**

新建 `tests/onedriveUploadSessionRequest.test.ts`,抽 `_buildCreateUploadSessionBody` 纯函数(不含 conflictBehavior 文档明确支持与 If-Match 共存):

```ts
import "./_globalsSetup";
import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { _buildCreateUploadSessionBody } from "../src/fsOnedrive";

describe("createUploadSession body builder", () => {
  it("no expectedEtag: body has conflictBehavior only", () => {
    const b = _buildCreateUploadSessionBody(undefined, undefined, undefined);
    assert.strictEqual(b.item["@microsoft.graph.conflictBehavior"], "replace");
    assert.ok(!("If-Match" in b));  // If-Match 是 header 不是 body;此处只验 body
  });
  it("with mtime: body includes fileSystemInfo", () => {
    const b = _buildCreateUploadSessionBody("2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z", undefined);
    assert.deepEqual(b.item.fileSystemInfo, { lastModifiedDateTime: "2024-01-01T00:00:00Z", createdDateTime: "2024-01-01T00:00:00Z" });
  });
});
```

> `If-Match` 作为 header 在 `_postJson` 发送,body builder 只管 body。`If-Match` 是否发送由 `_postJson` 调用方传 header。

- [ ] **Step 2: 跑确认失败**

```bash
npx mocha --import=tsx tests/onedriveUploadSessionRequest.test.ts
```
Expected: FAIL(未导出)。

- [ ] **Step 3: 实现**

`src/fsOnedrive.ts` 新增 export:

```ts
export function _buildCreateUploadSessionBody(mtimeStr?: string, ctimeStr?: string, _expectedEtag?: string) {
  const item: any = { "@microsoft.graph.conflictBehavior": "replace" };
  if (mtimeStr !== undefined && ctimeStr !== undefined) {
    item.fileSystemInfo = { lastModifiedDateTime: mtimeStr, createdDateTime: ctimeStr };
  }
  return { item };
}
```

改 createUploadSession 段(`:1076-1099`):用 `_buildCreateUploadSessionBody`,并在 `_postJson` 调用时若 `expectedEtag` 存在则带 `If-Match` header。`_postJson` 加可选 `headers?: Record<string,string>` 参数合并。

改 `_putUint8ArrayByRange`(`:680-738`):`!res.ok` 分支加:
```ts
if (res.status === 412 && key !== undefined) { throw remoteEtagMismatchError(key); }
```
(需给 `_putUint8ArrayByRange` 加 `key?` 参数,由 uploadSession 循环传 `origKey`。)

改 `_patchJson`(`:563-579`):`_patchJson` 用 Obsidian `request`,抛 `Error("Request failed, status 412")`。在 `_writeFileFromRoot` 调 `_patchJson` 后包一层 catch 转换:
```ts
try {
  driveItem = await this._patchJson(key, { fileSystemInfo: { lastModifiedDateTime: mtimeStr, createdDateTime: ctimeStr } as FileSystemInfo });
} catch (e) {
  if (classifyOneDriveWriteError(e) === "REMOTE_ETAG_MISMATCH" && origKey) { throw remoteEtagMismatchError(origKey); }
  throw e;
}
```
> 注意 spec §6.4:PATCH 应用 PUT 响应的新 etag 才不会被 412 误报。但 MVP 阶段(用户拍板 P5 不做),先按"PATCH 失败即视为冲突"的保守策略——宁可误报导流合并,不可漏检。Task 10 手动验证若误报频繁,再回过头用 PUT 响应新 etag 给 PATCH。

- [ ] **Step 4: 跑确认通过 + 全套**

```bash
npx mocha --import=tsx tests/onedriveUploadSessionRequest.test.ts
npm test
```
Expected: PASS、不回归。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/fsOnedrive.ts tests/onedriveUploadSessionRequest.test.ts
git commit -m "feat(onedrive): createUploadSession + fragments send If-Match, convert 412"
```

---

## Task 6: `sync.ts` push 分支 412 re-route 到 smart_conflict(**核心行为**)

> 这是消除静默丢数据的关键点。412 = OneDrive 原子拒绝,**未写入**,故本地无半状态,re-route 安全。

**Files:**
- Modify: `src/sync.ts:1667-1736`(抽 `handleConflictModifiedSmartConflict`)
- Modify: `src/sync.ts:1562-1595`(push 分支 try/catch `REMOTE_ETAG_MISMATCH` → 调抽出的函数)
- Test: `tests/syncDispatchIfMatch.test.ts`(新建)

**Interfaces:**
- Consumes: Task 2 `remoteEtagMismatchError`(`.code==="REMOTE_ETAG_MISMATCH"`)经 `makeCatch` 透传;Task 4/5 抛出的 error 形态
- Produces: push 撞 412 时复用 `mergeFile`/`tryDuplicateFile` 路径(与可见冲突完全一致)

- [ ] **Step 1: 写失败测试(mock FakeFs `writeFile` 抛 `REMOTE_ETAG_MISMATCH`,验证 re-route)**

新建 `tests/syncDispatchIfMatch.test.ts`。复用 `tests/conflictLogicFull.test.ts:36-105` 的 mock FakeFs 模式 + `tests/localdb.test.ts:61-134` 的 mock DB。由于 `dispatchOperationToActualV3` 未被 export(`const`),需先在 Task 6 把它 `export`(或测一个更薄的入口)。**最小可行:export `dispatchOperationToActualV3`**(sync.ts 内部 const 改 export const,不影响打包)。

```ts
import "./_globalsSetup";
import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { dispatchOperationToActualV3 } from "../src/sync";
import { createMockDB, asDB } from "./_dbMock"; // 见 Step 3 抽出
import { makeMockFs } from "./_fsMock";          // 见 Step 3 抽出

describe("dispatchOperationToActualV3: 412 re-route", () => {
  it("push throws REMOTE_ETAG_MISMATCH -> routes to mergeFile path", async () => {
    // fsLocal: 本地有 a.md (B 的版本), mtimeCli=2000
    const local = makeMockFs("local", { "a.md": buf("B-version") }, { "a.md": { mtime: 2000, etag: undefined } });
    // fsEncrypt(remote): writeFile 抛 REMOTE_ETAG_MISMATCH;readFile 返回 A 的版本(供 mergeFile 取 right content)
    const remote = makeMockFs("remote", { "a.md": buf("A-version") }, { "a.md": { mtime: 1500, etag: '"vA"' } });
    (remote as any).writeFile = async (key: string) => {
      const e = new Error("mismatch");
      (e as any).code = "REMOTE_ETAG_MISMATCH";
      (e as any).key = key;
      throw e;
    };
    const db = asDB(createMockDB());
    // 预置 fileContentHistory 基(base = P 版本)
    await db.fileContentHistoryTbl.setItem("vault\tprof\ta.md", buf("P-version"));

    const r: any = {
      key: "a.md", local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 9, etag: undefined },
      prevSync: { key: "a.md", keyRaw: "a.md", mtimeSvr: 1000, sizeRaw: 8, etag: '"vP"' },
      remote: { key: "a.md", keyRaw: "a.md", mtimeSvr: 1500, sizeRaw: 9, etag: '"vA"' },
      decision: "local_is_modified_then_push",
      conflictAction: "smart_conflict",
    };
    await dispatchOperationToActualV3("a.md", "vault", "prof", r, local as any, remote as any, db, "smart_conflict");
    // 期望:未静默丢 B;mergeFile 把合并结果写到 local+remote
    assert.ok((remote as any).__writes.find((w: any) => w.key === "a.md"), "merged result written back to remote");
    assert.ok((local as any).__writes.find((w: any) => w.key === "a.md"), "merged result written back to local");
  });
});
```

> `_dbMock.ts`/`_fsMock.ts` 为测试 helper,从 `tests/localdb.test.ts:61-134` 与 `tests/conflictLogicFull.test.ts:36-105` 抽公共部分。Step 3 含抽 helper。

- [ ] **Step 2: 跑确认失败**

```bash
npx mocha --import=tsx tests/syncDispatchIfMatch.test.ts
```
Expected: FAIL(`dispatchOperationToActualV3` 未 export,或 push 抛错未 re-route)。

- [ ] **Step 3: 抽 helper + 实现 re-route**

抽测试 helper:`tests/_fsMock.ts`(从 conflictLogicFull 抽 `makeMockFs`,加 `__writes` 记录)、`tests/_dbMock.ts`(从 localdb.test 抽 `createMockDB`/`asDB`)。原测试文件改 import,跑一遍确认不破。

`src/sync.ts`:
- `const dispatchOperationToActualV3` → `export const dispatchOperationToActualV3`(`:1461`)。
- 把 `:1667-1736` 的 conflict 分支 body 抽成 `export const handleConflictModifiedSmartConflict = async (r, fsLocal, fsEncrypt, db, vaultRandomID, profileID) => { ... }`(原 body 原样搬入,参数化)。
- push 分支(`:1562-1595`)改为 try/catch:

```ts
} else if (r.decision === "local_is_modified_then_push" || /* 其他原分支 */) {
  const mtimeCli = (await fsLocal.stat(r.key)).mtimeCli!;
  try {
    const { entity, content } = await copyFileOrFolder(r.key, fsLocal, fsEncrypt, r.remote?.etag);
    fullfillMTimeOfRemoteEntityInplace(entity, mtimeCli);
    await upsertPrevSyncRecordByVaultAndProfile(db, vaultRandomID, profileID, entity);
    if (conflictAction === "smart_conflict" && isMergable(entity)) {
      await upsertFileContentHistoryByVaultAndProfile(db, vaultRandomID, profileID, entity, content!);
    }
  } catch (e: any) {
    if ((e as any)?.code === "REMOTE_ETAG_MISMATCH") {
      // 412 = OneDrive 原子拒绝,未写入,本地无半状态 → 走可见冲突路径
      r.decision = "conflict_modified_then_smart_conflict";
      await handleConflictModifiedSmartConflict(r, fsLocal, fsEncrypt, db, vaultRandomID, profileID);
    } else {
      throw e;
    }
  }
}
```

- [ ] **Step 4: 跑确认通过 + conflictLogicFull 回归**

```bash
npx mocha --import=tsx tests/syncDispatchIfMatch.test.ts
npx mocha --import=tsx tests/conflictLogicFull.test.ts tests/conflictLogic.test.ts tests/copyLogic.test.ts
npm test
```
Expected: 新测试 PASS;conflict/copy 回归不破;全套绿。

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/sync.ts tests/syncDispatchIfMatch.test.ts tests/_fsMock.ts tests/_dbMock.ts tests/conflictLogicFull.test.ts tests/localdb.test.ts
git commit -m "feat(sync): re-route push 412 to smart_conflict (mergeFile/tryDuplicateFile), no silent clobber"
```

---

## Task 7: `main.ts` errNotifyFunc 通知 + 冲突日志文件

**Files:**
- Modify: `src/main.ts:408-447`(`errNotifyFunc` 加 `REMOTE_ETAG_MISMATCH` 分支)
- Create: `src/conflictLog.ts`(纯函数:append 日志条目)
- Modify: `src/baseTypes.ts`(默认 ignore 列表加日志文件名)
- Test: `tests/conflictLog.test.ts`(新建,纯函数可单测)

**Interfaces:**
- Consumes: Task 6 透传上来的 `REMOTE_ETAG_MISMATCH` error(`.code`/`.key`)
- Produces: Notice 提示 + `<vault 根>/.remotely-save-onedrive-conflicts.log` 追加;日志文件名进默认 sync ignore

- [ ] **Step 1: 写失败测试(日志条目格式化纯函数)**

新建 `tests/conflictLog.test.ts`:

```ts
import "./_globalsSetup";
import { strict as assert } from "assert";
import { describe, it } from "mocha";
import { formatConflictLogLine } from "../src/conflictLog";

describe("conflict log line", () => {
  it("formats timestamp + key + disposition", () => {
    const line = formatConflictLogLine({
      ts: new Date("2026-09-20T12:00:00.000Z"),
      key: "vault/a.md",
      walkEtag: '"vP"',
      writeEtag: undefined,  // 412 时拿不到写时 etag
      disposition: "merged",
    });
    assert.match(line, /2026-09-20T12:00:00/);
    assert.match(line, /a\.md/);
    assert.match(line, /merged/);
    assert.match(line, /\n$/);  // 行尾换行
  });
});
```

- [ ] **Step 2: 跑确认失败**

```bash
npx mocha --import=tsx tests/conflictLog.test.ts
```
Expected: FAIL(未导出)。

- [ ] **Step 3: 实现**

新建 `src/conflictLog.ts`:

```ts
export const CONFLICT_LOG_FILENAME = ".remotely-save-onedrive-conflicts.log";

export interface ConflictLogEntry {
  ts: Date;
  key: string;
  walkEtag?: string;
  writeEtag?: string;
  disposition: "merged" | "duplicated" | "kept_local" | "kept_remote";
  resultFile?: string;
}

export function formatConflictLogLine(e: ConflictLogEntry): string {
  const parts = [
    e.ts.toISOString(),
    e.key,
    `walkEtag=${e.walkEtag ?? "?"}`,
    `writeEtag=${e.writeEtag ?? "?"}`,
    `disposition=${e.disposition}`,
    e.resultFile ? `result=${e.resultFile}` : "",
  ].filter(Boolean);
  return parts.join(" ") + "\n";
}

// 追加到 vault 根的日志文件(调用方传 Vault.adapter)
export async function appendConflictLog(adapter: any, line: string): Promise<void> {
  const exists = await adapter.exists(CONFLICT_LOG_FILENAME).catch(() => false);
  const prev = exists ? await adapter.read(CONFLICT_LOG_FILENAME).catch(() => "") : "";
  await adapter.write(CONFLICT_LOG_FILENAME, prev + line);
}
```

`src/main.ts:408-447` errNotifyFunc:在 `REMOTE_NOT_FOUND` 分支旁加 `REMOTE_ETAG_MISMATCH`:

```ts
const etagMismatches: any[] = [];
if (error instanceof AggregateError) {
  for (const e of error.errors) {
    if ((e as any)?.code === "REMOTE_NOT_FOUND") { notFound.push(e); }
    else if ((e as any)?.code === "REMOTE_ETAG_MISMATCH") { etagMismatches.push(e); }
    else { others.push(e); }
  }
} else {
  if ((error as any)?.code === "REMOTE_NOT_FOUND") { await selfHealStaleDelta(); }
  else if ((error as any)?.code === "REMOTE_ETAG_MISMATCH") { etagMismatches.push(error as any); }
}
if (etagMismatches.length > 0) {
  const names = etagMismatches.map((e) => e.key).slice(0, 5).join(", ");
  new Notice(`并发冲突已合并/存副本,请查看: ${names}`, 10 * 1000);
  const adapter = this.app.vault.adapter;
  for (const e of etagMismatches) {
    await appendConflictLog(adapter, formatConflictLogLine({
      ts: new Date(), key: e.key, disposition: "merged",  // disposition 精确化见下
    }));
  }
}
```

> `disposition` 精确值需 sync.ts 在 re-route 后回写(Task 6 的 `handleConflictModifiedSmartConflict` 走 merge 还是 dup 是运行时决定的)。MVP 阶段先记 `"merged"` 占位;后续可由 sync.ts 通过 error 附加字段回传真实 disposition(标记为 TODO 进 Task 8 收尾)。

`src/baseTypes.ts`:默认 ignore 列表加 `CONFLICT_LOG_FILENAME`(参考现有 sync ignore 默认项的写法,grep `ignore` 在 baseTypes 找位置)。

- [ ] **Step 4: 跑确认通过 + 全套**

```bash
npx mocha --import=tsx tests/conflictLog.test.ts
npm test
npm run typecheck
```
Expected: PASS、不回归。

- [ ] **Step 5: commit**

```bash
git add src/conflictLog.ts src/main.ts src/baseTypes.ts tests/conflictLog.test.ts
git commit -m "feat(notify): Notice + .remotely-save-onedrive-conflicts.log on 412 conflict"
```

---

## Task 8: 写后 `prevSync.etag` 验证 + disposition 回传

> 验证 Task 1+3+4 联动:push 成功后 `Entity.etag`(来自 `fromDriveItemToEntity` 映射的写响应新 etag)正确进 `prevSync`,供下一轮 If-Match。并把 Task 7 的 `disposition` 从 `"merged"` 占位改为真实值。

**Files:**
- Modify: `src/sync.ts` `handleConflictModifiedSmartConflict`(merge/dup 分支把 disposition 挂到 error 或回调)
- Test: `tests/syncDispatchIfMatch.test.ts`(扩:验证 push 成功后 prevSync.etag 被写)

- [ ] **Step 1: 扩测试**

在 `tests/syncDispatchIfMatch.test.ts` 加一条:push 成功(无 412)后,`prevSyncRecordsTbl` 里 `a.md` 的记录 `etag` 非空。

```ts
it("push success stores new remote etag into prevSync", async () => {
  const local = makeMockFs("local", { "a.md": buf("B") }, { "a.md": { mtime: 2000 } });
  const remote = makeMockFs("remote", {}, {});
  (remote as any).writeFile = async (key: string) => ({ key, keyRaw: key, mtimeCli: 2000, sizeRaw: 1, etag: '"vNew"' });
  const db = asDB(createMockDB());
  const r: any = { key: "a.md", local: { key: "a.md", keyRaw: "a.md", mtimeCli: 2000, sizeRaw: 1 }, prevSync: undefined, remote: { key: "a.md", keyRaw: "a.md", etag: '"vOld"' }, decision: "local_is_modified_then_push", conflictAction: "smart_conflict" };
  await dispatchOperationToActualV3("a.md", "vault", "prof", r, local as any, remote as any, db, "smart_conflict");
  const rec = await db.prevSyncRecordsTbl.getItem("vault\tprof\ta.md");
  assert.strictEqual(rec?.etag, '"vNew"');
});
```

- [ ] **Step 2: 跑确认失败/通过**

若 Task 1+3+4 正确,此测试应直接 PASS(写响应 driveItem 经 `fromDriveItemToEntity` 带新 etag → `upsertPrevSyncRecord` 存下)。若 FAIL,定位 `_writeFileFromRoot` 返回 entity 是否带 etag。

```bash
npx mocha --import=tsx tests/syncDispatchIfMatch.test.ts
```

- [ ] **Step 3: disposition 回传(Task 7 的精确化)**

`handleConflictModifiedSmartConflict` 在 merge 分支调 `mergeFile` 后,把 `disposition:"merged"`;dup 分支 `tryDuplicateFile` 后 `disposition:"duplicated"`。通过把值挂到上层可见状态(如 `r.sideNotes` 或返回值),`main.ts` errNotifyFunc 读之。若改动量大,MVP 可保留 `"merged"` 占位 + Task 7 日志标"disposition 精确化待后续",不阻塞上线。

- [ ] **Step 4: 全套 + commit**

```bash
npm test && npm run typecheck
git add src/sync.ts tests/syncDispatchIfMatch.test.ts
git commit -m "feat(sync): persist new etag in prevSync after push; propagate conflict disposition"
```

---

## Task 9: OneDrive 并发机制 reference 文档

**Files:**
- Create: `docs/remote_services/onedrive/concurrency.md`
- Modify: `docs/remote_services/onedrive/README.md`(加链接)

- [ ] **Step 1: 抽 spec §4 内容为独立 reference**

把 `docs/superpowers/specs/2026-09-20-onedrive-if-match-concurrency-guard-design.md` 的 §4(OneDrive 并发机制 reference 草稿)整理为独立 `docs/remote_services/onedrive/concurrency.md`,补"本插件如何使用各项"的当前状态列(改造后状态)。

- [ ] **Step 2: README 加链接**

`docs/remote_services/onedrive/README.md` 的 `## Related` 段加:
```md
- [OneDrive Concurrency Mechanisms](./concurrency.md) — etag/cTag, If-Match, conflictBehavior, delta, versions
```

- [ ] **Step 3: commit**

```bash
git add docs/remote_services/onedrive/concurrency.md docs/remote_services/onedrive/README.md
git commit -m "docs(onedrive): add concurrency mechanisms reference (etag/If-Match/conflictBehavior/delta)"
```

---

## Task 10: `PUT :/content` If-Match 实测 + 契约重审(**手动验证收尾**)

> 经验性步骤:验证小文件 PUT 带 If-Match 真的让 OneDrive 返回 412(spec §6.2 阶段 1)。无自动化,记入 `docs/how_to_debug/` 或 PR 说明。

- [ ] **Step 1: 准备测试账号与两步手动脚本**

用真实 OneDrive 测试账号(vault 配好),写一个临时调试脚本(放 `scripts/` 或临时文件,不入仓):
1. 上传 `test.md`,记录返回 `eTag = v1`。
2. 再次 PUT `test.md` 带 `If-Match: v1` → 期望 200/201,返回新 `eTag = v2`。
3. 再次 PUT `test.md` 带 `If-Match: v1`(旧值)→ **期望 412**。
4. 用 `createUploadSession` 带 `If-Match: v1` 重复 2-3,确认 412。

- [ ] **Step 2: 结果记录与决策**

- 若 PUT/content + If-Match 实测返回 412 → spec §6.2 阶段 1 成立,小文件路径保留 PUT,**无需 P2-fallback**。
- 若 PUT/content 不认 If-Match(直接 200 覆盖)→ 触发 P2-fallback:小文件改走 `createUploadSession`(`_writeFileFromRoot` 小文件分支改为调 createUploadSession 路径)。记录决策到 spec §6.2 与 PR 说明。

- [ ] **Step 3: 契约重审(AGENTS.md 规矩)**

重读 `PUT :/content`、`createUploadSession`、`PATCH driveItem` 的 Remarks,确认:412 响应体形态、`eTag`/`cTag` 字段在新调用模式下仍保证返回。把核验结论写入 `docs/lessons/`(参考 `onedrive-delta-parentreference-path.md` 先例)或 PR 描述。

- [ ] **Step 4: commit 决策记录**

```bash
git add docs/lessons/onedrive-if-match-put-content-verification.md  # 或 PR 描述
git commit -m "docs(lessons): verify PUT/content honors If-Match; record contract re-audit"
```

---

## Self-Review(plan 写完自检)

**1. Spec 覆盖:**
- §2.1 目标1(不静默丢)→ Task 6(re-route)+ Task 7(通知/日志)。✓
- §2.1 目标2(平时零额外开销)→ Task 4 小文件加 If-Match 只加 header(实测见 Task 10);Task 3 透传无额外请求。✓
- §2.1 目标3(复用已有冲突处理)→ Task 6 复用 `mergeFile`/`tryDuplicateFile`。✓
- §2.1 目标4(补 reference 文档)→ Task 9。✓
- §5.1 数据流 walk→plan→push(If-Match)→412→conflict → Task 4/5/6。✓
- §5.2 三条写入路径 → Task 4(小文件 PUT)、Task 5(createUploadSession + 分片 + PATCH)。✓
- §5.3 412 导流 → Task 6。✓
- §6.1 接通 etag → Task 1+3。✓
- §6.2 小文件实测/退路 → Task 10。✓
- §6.3 deferCommit(非 MVP)→ 未做,符合用户决策。✓
- §6.4 PUT-PATCH etag 轮转 → Task 5 Step 3 注释(MVP 保守策略,Task 10 后回头优化)。✓
- §6.5 写后 re-stat → Task 8(写响应带新 etag 入 prevSync;若实测响应不带全字段,补 stat)。✓
- §6.6 eTag vs cTag → Task 4/5 用 eTag(spec 默认)。✓
- §6.7 空文件/新建文件 → Task 4 仅对 `expectedEtag` 存在时发 If-Match(新建无 etag 不发,保持现状)。✓
- §7 通知+日志 → Task 7。✓
- §8.5 契约重审 → Task 10 Step 3。✓
- 已确认决策 1-4 → 通知两者(Task 7)/小文件实测(Task 10)/deferCommit 不做/日志 vault 根(Task 7)。✓

**2. 占位符扫描:** 无 TBD/TODO(仅 Task 7 Step 3 标了 disposition 精确化为"后续",有明确兜底,非阻断)。代码块均含真实实现。✓

**3. 类型一致:** `Entity.etag?: string`(Task 1)→ `r.remote?.etag`(Task 3)→ `expectedEtag?: string`(Task 3 透传)→ `_putArrayBuffer(..., ifMatch?, key?)`(Task 4)。`remoteEtagMismatchError(key): Error`(`.code="REMOTE_ETAG_MISMATCH"`,Task 2)→ `classifyOneDriveWriteError`(Task 2)→ Task 4/5 catch。`dispatchOperationToActualV3`/`handleConflictModifiedSmartConflict`(Task 6)签名一致。✓

**4. 风险标注:** HTTP 层无 fetch mock——Task 4/5 的 412 转换依赖 Task 2 纯函数 + Task 10 手动验证,已在各 Task 注明。Task 6 是唯一纯行为单测点,已给出可运行的 mock 模式。✓
