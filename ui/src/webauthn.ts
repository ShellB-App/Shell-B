/** WebAuthn ceremonies for passkeys (server/auth.py /api/auth/passkeys/*): the server speaks py_webauthn's JSON, the
 * browser wants ArrayBuffers; these convert both ways and run navigator.credentials.create / get. */
import { api } from './api';

const b64u = {
  toBuf(s: string): ArrayBuffer {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  },
  fromBuf(b: ArrayBuffer): string {
    return btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
};

export const passkeysSupported = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials?.create;

function creationOptions(o: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions {
  return {
    ...o,
    challenge: b64u.toBuf(o.challenge),
    user: { ...o.user, id: b64u.toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials ?? []).map(c => ({ ...c, id: b64u.toBuf(c.id) })),
  } as PublicKeyCredentialCreationOptions;
}

function requestOptions(o: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions {
  return { ...o, challenge: b64u.toBuf(o.challenge), allowCredentials: (o.allowCredentials ?? []).map(c => ({ ...c, id: b64u.toBuf(c.id) })) } as PublicKeyCredentialRequestOptions;
}

function credentialJson(c: PublicKeyCredential) {
  const r = c.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const out: Record<string, unknown> = {
    id: c.id, rawId: b64u.fromBuf(c.rawId), type: c.type, authenticatorAttachment: (c as PublicKeyCredential & { authenticatorAttachment?: string }).authenticatorAttachment ?? null,
    clientExtensionResults: c.getClientExtensionResults(),
    response: {
      clientDataJSON: b64u.fromBuf(r.clientDataJSON),
      ...(r.attestationObject ? { attestationObject: b64u.fromBuf(r.attestationObject) } : {}),
      ...(r.authenticatorData ? { authenticatorData: b64u.fromBuf(r.authenticatorData) } : {}),
      ...(r.signature ? { signature: b64u.fromBuf(r.signature) } : {}),
      ...(r.userHandle ? { userHandle: b64u.fromBuf(r.userHandle) } : {}),
    },
  };
  return out;
}

/** Register a new passkey for the owner (needs the current password). */
export async function registerPasskey(password: string, label: string) {
  const { challengeId, options } = await api.passkeyRegisterBegin(password);
  const cred = (await navigator.credentials.create({ publicKey: creationOptions(options) })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was made');
  const transports = ((cred.response as AuthenticatorAttestationResponse).getTransports?.() ?? []) as string[];
  return api.passkeyRegisterFinish({ challengeId, credential: credentialJson(cred), label, transports });
}

/** Sign in with a passkey registered for this address. */
export async function loginWithPasskey() {
  const { challengeId, options } = await api.passkeyLoginBegin();
  const cred = (await navigator.credentials.get({ publicKey: requestOptions(options) })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was offered');
  return api.passkeyLoginFinish({ challengeId, credential: credentialJson(cred) });
}
