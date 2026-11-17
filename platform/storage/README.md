# @platform/storage

This package gives the process its one Azure Blob store and container, and a stand-in for tests. Access is keyless: the identity holds a Storage Blob Data role on the account, so the account key stays disabled. Nothing here signs a URL; a blob reaches a client only as bytes the process read and streamed.

- `store` — the store as the environment describes it: `AZURE_STORAGE_ACCOUNT` names the account and its blob origin, `AZURE_STORAGE_ENDPOINT` overrides the origin for an emulator, `AZURE_STORAGE_CONTAINER` is the one container, `library` by default. With neither account nor endpoint there is no store, and nothing is there to read.
- `service` — the one `BlobServiceClient` on `azureCredential()`.
- `blobs` — the container blob by blob:
  - `listBlobs`, with each blob's type, the MD5 the service computed and its metadata;
  - `blobProperties`;
  - `readBlob`, streamed, null when absent, and from another container on the same account when one is named;
  - `putBlob`, whole, typed, with metadata;
  - `describeBlob`, which replaces the metadata and rewrites the type without losing the MD5;
  - `deleteBlob`.

  Metadata keys come back lower-cased, because they travel as HTTP headers.

`@platform/storage/testing` holds the stand-in at the SDK boundary and nowhere else: a recording container that keeps the type, the MD5 and the metadata beside the bytes, and the store's three variables scoped to a test over `@platform/test-support`'s `scopedEnv`.
