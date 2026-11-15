# Here lies the Python concerned with encryption, data secrecy and cryptographic utilities
# This handles symmetric stream encryption, authenticated HMAC verification and master key resolution
# Remember consistency is key

import base64
import hashlib
import hmac
import os
import secrets

# Prefix marker identifying encrypted payloads for backward-compatible plaintext pass-through
ENC_PREFIX = "enc:v1:"

# Decodes hexadecimal secret material into raw bytes or hashes fallback passphrases with SHA-256
def _decodeSecretMaterial(rawValue):
    cleaned = str(rawValue or "").strip()
    if not cleaned:
        return None
    try:
        rawBytes = bytes.fromhex(cleaned)
        if len(rawBytes) >= 32:
            return rawBytes[:32]
    except ValueError:
        pass
    return hashlib.sha256(cleaned.encode("utf-8")).digest()

# Retrieves or generates the 32-byte master encryption secret from environment or storage
def getDataSecret(storageRoot):
    envSecret = os.environ.get("TSW6_DATA_KEY") or os.environ.get("TSW6TI_DATA_KEY")
    parsedEnv = _decodeSecretMaterial(envSecret)
    if parsedEnv is not None:
        return parsedEnv

    os.makedirs(storageRoot, exist_ok=True)
    keyPath = os.path.join(storageRoot, ".data_secret.key")
    if os.path.exists(keyPath):
        with open(keyPath, "r", encoding="utf-8") as f:
            parsedFile = _decodeSecretMaterial(f.read())
        if parsedFile is not None:
            return parsedFile

    rawBytes = secrets.token_bytes(32)
    fd = os.open(keyPath, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(rawBytes.hex())
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        raise
    return rawBytes

# Derives dedicated encryption and message authentication subkeys from the master secret
def _deriveSubkeys(masterKey):
    encKey = hashlib.sha256(b"tsw6ti-enc-v1:" + masterKey).digest()
    macKey = hashlib.sha256(b"tsw6ti-mac-v1:" + masterKey).digest()
    return encKey, macKey

# Generates a pseudo-random keystream of specified length using HMAC-SHA256 in counter mode
def _keystream(encKey, nonce, length):
    blocks = []
    counter = 0
    total = 0
    while total < length:
        block = hmac.new(encKey, nonce + counter.to_bytes(4, "big"), hashlib.sha256).digest()
        blocks.append(block)
        total += len(block)
        counter += 1
    return b"".join(blocks)[:length]

# Encrypts sensitive string values using stream encryption with HMAC authentication
def encryptValue(plaintext, masterKey):
    if plaintext is None:
        return ""
    text = str(plaintext)
    if text == "":
        return ""
    if text.startswith(ENC_PREFIX):
        return text

    encKey, macKey = _deriveSubkeys(masterKey)
    nonce = secrets.token_bytes(16)
    ptBytes = text.encode("utf-8")
    stream = _keystream(encKey, nonce, len(ptBytes))
    ciphertext = bytes(a ^ b for a, b in zip(ptBytes, stream))
    tag = hmac.new(macKey, nonce + ciphertext, hashlib.sha256).digest()
    blob = base64.urlsafe_b64encode(nonce + tag + ciphertext).decode("ascii")
    return ENC_PREFIX + blob

# Decrypts encrypted string values and verifies cryptographic authenticity tags
def decryptValue(stored, masterKey):
    if stored is None:
        return ""
    text = str(stored)
    if not text.startswith(ENC_PREFIX):
        return text

    raw = base64.urlsafe_b64decode(text[len(ENC_PREFIX):].encode("ascii"))
    if len(raw) < 48:
        raise ValueError("Corrupted encrypted payload")

    nonce = raw[:16]
    tag = raw[16:48]
    ciphertext = raw[48:]

    encKey, macKey = _deriveSubkeys(masterKey)
    expectedTag = hmac.new(macKey, nonce + ciphertext, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expectedTag):
        raise ValueError("Authentication tag mismatch")

    stream = _keystream(encKey, nonce, len(ciphertext))
    ptBytes = bytes(a ^ b for a, b in zip(ciphertext, stream))
    return ptBytes.decode("utf-8")

# Backwards compatibility function aliases
get_data_secret = getDataSecret
encrypt_value = encryptValue
decrypt_value = decryptValue
