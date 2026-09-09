# Image attachments

## Type

As-is

## Lifecycle

Active

## Behavior

A local image selected as an attachment is converted into the request's
multimodal image content before the model call. Attachment metadata remains
associated with the originating message and unsupported local files are not
silently promoted to image blocks.

## Related files

- `src/messages/attachments.ts`
- `tests/messages/attachments.test.ts`
