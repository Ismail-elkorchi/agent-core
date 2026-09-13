import { parseJsonObject } from '@agent-core/json';
import type { ModelProfile } from '@agent-core/model';
import { parseModelImages, type ModelImage, type ModelImageDetail } from '@agent-core/model';
import {
  decodeOwnedArtifactRef,
  type ArtifactRepository,
  type PublicArtifactRef
} from '@agent-core/persistence';
import {
  DEFAULT_MODEL_WINDOW_IMAGE_LIMITS,
  type ModelWindowImageLimits
} from '../inference/model-window.js';

export interface SessionImageInput {
  readonly artifact: PublicArtifactRef;
  readonly detail?: ModelImageDetail;
}
export function parseSessionImages(value: unknown): readonly SessionImageInput[] {
  if (!Array.isArray(value)) throw new Error('Session images must be an array.');
  return Object.freeze(
    value.map((entry) => {
      const image = parseJsonObject(entry);
      if (Object.keys(image).some((key) => key !== 'artifact' && key !== 'detail'))
        throw new Error('Unsupported session image field.');
      const artifact = decodeOwnedArtifactRef(parseJsonObject(image.artifact));
      if (artifact.visibility !== 'public' || !artifact.mediaType.startsWith('image/'))
        throw new Error('Session images require public image artifacts.');
      const detail = image.detail;
      if (
        detail !== undefined &&
        detail !== 'auto' &&
        detail !== 'low' &&
        detail !== 'high' &&
        detail !== 'original'
      )
        throw new Error('Invalid session image detail.');
      return Object.freeze({ artifact, ...(detail === undefined ? {} : { detail }) });
    })
  );
}
/** Resolve only admitted public image references; payloads never become text in session records. */
export async function resolveSessionImages(
  images: readonly SessionImageInput[],
  artifacts: ArtifactRepository | undefined,
  maxBytes: number
): Promise<readonly ModelImage[]> {
  if (images.length === 0) return [];
  if (artifacts === undefined) throw new Error('Native image input requires an artifact repository.');
  if (images.reduce((total, image) => total + image.artifact.size, 0) > maxBytes)
    throw new Error('context_admission_failed: image artifacts exceed the admitted byte limit.');
  const resolved: ModelImage[] = [];
  for (const image of images) {
    const bytes = await artifacts.readVerified(image.artifact);
    resolved.push(
      ...parseModelImages([
        {
          type: 'bytes',
          mediaType: image.artifact.mediaType,
          data: bytes,
          ...(image.detail === undefined ? {} : { detail: image.detail })
        }
      ])
    );
  }
  return resolved;
}

/** Fail before accepting a user draft; complete request admission still owns history and token accounting. */
export function assertSessionImagesSupported(
  images: readonly SessionImageInput[],
  profile: ModelProfile,
  limits: ModelWindowImageLimits = DEFAULT_MODEL_WINDOW_IMAGE_LIMITS
): void {
  if (images.length === 0) return;
  if (!profile.modalities.input.includes('image'))
    throw new Error(
      'The selected model does not accept images. Remove the attachments or choose an image-capable model.'
    );
  if (images.length > limits.maxCount)
    throw new Error(
      `The draft has ${String(images.length)} images; the image limit is ${String(limits.maxCount)}.`
    );
  if (images.reduce((bytes, image) => bytes + image.artifact.size, 0) > limits.maxBytes)
    throw new Error(`The draft images exceed the ${String(limits.maxBytes)}-byte image limit.`);
}
