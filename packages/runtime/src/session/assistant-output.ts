import { parseModelResponse, type ModelOutputItem } from '@agent-core/model';

/** Own typed output through the model codec, then give binary image bytes a lossless JSON representation. */
export function ownSessionAssistantOutput(value: unknown): readonly ModelOutputItem[] {
  const output =
    parseModelResponse({
      provider: 'recorded-session',
      model: 'recorded-session',
      content: '',
      terminationReason: 'unknown',
      output: value
    }).output ?? [];
  return Object.freeze(
    output.map((item): ModelOutputItem => {
      if (item.type !== 'media' || item.part.type !== 'image' || item.part.image.type !== 'bytes')
        return item;
      const image = item.part.image;
      return Object.freeze({
        type: 'media',
        part: Object.freeze({
          type: 'image',
          image: Object.freeze({
            type: 'base64',
            data: Buffer.from(image.data).toString('base64'),
            mediaType: image.mediaType,
            ...(image.detail ? { detail: image.detail } : {})
          })
        })
      });
    })
  );
}
