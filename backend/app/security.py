"""Password hashing (argon2id). Used by the seed script and the login flow.

We never store or log plaintext passwords. Demo passwords are generated/sourced
at seed time and printed once to the console — never written to source.
"""
from __future__ import annotations

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_ph = PasswordHasher()  # argon2id defaults are sensible for an interactive login


def hash_password(plaintext: str) -> str:
    return _ph.hash(plaintext)


def verify_password(password_hash: str, plaintext: str) -> bool:
    try:
        _ph.verify(password_hash, plaintext)
        return True
    except VerifyMismatchError:
        return False
    except Exception:
        # Malformed hash etc. — treat as a failed verification, never raise to caller.
        return False


def needs_rehash(password_hash: str) -> bool:
    return _ph.check_needs_rehash(password_hash)
