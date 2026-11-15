// The page loads nothing from other hosts. Above all, no remote images: an answer could otherwise
// make the browser send chat text to any server in an image URL, without a click.
const directives = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  // markdown-it aligns table cells with style attributes.
  'style-src': ["'self'", "'unsafe-inline'"],
  // data: for the stylesheet's icons and data images in answers, blob: for picked files.
  'img-src': ["'self'", 'data:', 'blob:'],
  // blob: for the speech audio.
  'media-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
};

export const contentSecurityPolicy = Object.entries(directives)
  .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
  .join('; ');
