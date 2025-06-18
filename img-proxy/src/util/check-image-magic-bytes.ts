export const ImageType = {
  JPEG: "jpeg",
  PNG: "png",
  GIF: "gif",
  WEBP: "webp",
  BMP: "bmp",
  AVIF: "avif",
  HEIC: "heic",
};

export type ImageType = (typeof ImageType)[keyof typeof ImageType];

// Define signatures with optional offset and skip patterns
const signatures: Array<{
  format: ImageType;
  signature: (number | null)[];
  offset?: number;
  minSize?: number;
}> = [
  // JPEG: FF D8 FF
  {
    format: ImageType.JPEG,
    signature: [0xff, 0xd8, 0xff],
    minSize: 3,
  },

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  {
    format: ImageType.PNG,
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    minSize: 8,
  },

  // GIF87a or GIF89a
  {
    format: ImageType.GIF,
    signature: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
    minSize: 6,
  },
  {
    format: ImageType.GIF,
    signature: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
    minSize: 6,
  },

  // WebP: RIFF????WEBP
  {
    format: ImageType.WEBP,
    signature: [
      0x52,
      0x49,
      0x46,
      0x46, // RIFF
      null,
      null,
      null,
      null, // File size (4 bytes, variable)
      0x57,
      0x45,
      0x42,
      0x50, // WEBP
    ],
    minSize: 12,
  },

  // BMP: 42 4D
  {
    format: ImageType.BMP,
    signature: [0x42, 0x4d],
    minSize: 2,
  },

  // ICO: 00 00 01 00
  // {
  //   format: "ico",
  //   signature: [0x00, 0x00, 0x01, 0x00],
  //   minSize: 4,
  // },

  // TIFF (little-endian): 49 49 2A 00
  // {
  //   format: "tiff-le",
  //   signature: [0x49, 0x49, 0x2a, 0x00],
  //   minSize: 4,
  // },

  // // TIFF (big-endian): 4D 4D 00 2A
  // {
  //   format: "tiff-be",
  //   signature: [0x4d, 0x4d, 0x00, 0x2a],
  //   minSize: 4,
  // },

  // AVIF: ????ftypavif
  {
    format: ImageType.AVIF,
    signature: [
      null,
      null,
      null,
      null, // Box size (4 bytes, variable)
      0x66,
      0x74,
      0x79,
      0x70, // ftyp
      0x61,
      0x76,
      0x69,
      0x66, // avif
    ],
    offset: 0,
    minSize: 12,
  },

  // HEIC/HEIF variations
  {
    format: ImageType.HEIC,
    signature: [
      null,
      null,
      null,
      null, // Box size
      0x66,
      0x74,
      0x79,
      0x70, // ftyp
      0x68,
      0x65,
      0x69,
      0x63, // heic
    ],
    minSize: 12,
  },
];

// Enhanced image format validation with magic bytes
export function checkImageMagicBytes(buffer: ArrayBuffer): ImageType | null {
  const bytes = new Uint8Array(buffer);

  // Quick size check
  if (!bytes || bytes.length === 0) {
    return null;
  }

  // Check each signature
  for (const { format, signature, offset = 0, minSize } of signatures) {
    // Skip if buffer is too small
    if (minSize && bytes.length < minSize) {
      continue;
    }

    // Check if we have enough bytes for this signature
    if (bytes.length < offset + signature.length) {
      continue;
    }

    let match = true;
    for (let i = 0; i < signature.length; i++) {
      const sigByte = signature[i];
      const fileByte = bytes[offset + i];

      // null means we don't care about this byte
      if (sigByte !== null && fileByte !== sigByte) {
        match = false;
        break;
      }
    }

    if (match) {
      return format;
    }
  }

  return null;
}
