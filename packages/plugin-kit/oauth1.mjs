import { Buffer } from 'node:buffer';
import { createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';

export function oauthEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase()
  );
}

export function oauth1Authorization({ url, method, key, token, consumerSecret, tokenSecret, privatePem }) {
  const parameters = {
    oauth_consumer_key: key,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: privatePem ? 'RSA-SHA1' : 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const normalized = [...url.searchParams, ...Object.entries(parameters)]
    .map(([name, value]) => oauthEncode(name) + '=' + oauthEncode(value))
    .sort((left, right) => {
      const [leftName, leftValue] = left.split('=');
      const [rightName, rightValue] = right.split('=');
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    })
    .join('&');
  const base = [method.toUpperCase(), url.origin + url.pathname, normalized].map(oauthEncode).join('&');
  try {
    parameters.oauth_signature = privatePem
      ? sign('RSA-SHA1', Buffer.from(base), createPrivateKey(privatePem)).toString('base64')
      : createHmac('sha1', oauthEncode(consumerSecret) + '&' + oauthEncode(tokenSecret))
          .update(base)
          .digest('base64');
  } catch {
    throw new Error('Could not sign the OAuth 1.0 request.');
  }
  return (
    'OAuth ' +
    Object.entries(parameters)
      .map(([name, value]) => name + '="' + oauthEncode(value) + '"')
      .join(', ')
  );
}
