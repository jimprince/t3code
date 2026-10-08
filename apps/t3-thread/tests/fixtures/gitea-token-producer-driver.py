"""Synthetic-only executable specification of the owner-approved pipe contract.

Never use this fixture for a real capture. Deployment owns the reviewed host driver.
"""
import hashlib
import json
import os
import signal
import subprocess
import sys


def drive(producer_path, expected_hash, consumer_argv, reap_seconds=10, after_hash=None):
    # A single read: execute the very bytes whose digest was checked, not a reopened path.
    code = open(producer_path, "rb").read(65537)
    if len(code) > 65536 or hashlib.sha256(code).hexdigest() != expected_hash:
        return 2, "Gitea token producer rejected."
    if after_hash:
        after_hash()
    namespace = {}
    try:
        exec(compile(code, "<verified-producer>", "exec"), namespace)
    except Exception:
        return 2, "Gitea token producer rejected."
    read_fd, write_fd = os.pipe()
    consumer = None
    supplied = False
    try:
        consumer = subprocess.Popen(consumer_argv, stdin=read_fd, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, start_new_session=True)
        os.close(read_fd)
        read_fd = -1
        # Producer can observe that the consumer has already been started.
        namespace["consumer_started"] = True
        namespace["supply_id3"](write_fd)
        supplied = True
    except Exception:
        pass  # Never format producer/platform exceptions; they may contain input.
    finally:
        os.close(write_fd)  # Close the sole parent write end so the consumer receives EOF.
        if read_fd != -1:
            os.close(read_fd)
    if consumer is None:
        return 2, "Gitea token consumer did not start."
    try:
        stdout, _stderr = consumer.communicate(timeout=reap_seconds)
    except subprocess.TimeoutExpired:
        os.killpg(consumer.pid, signal.SIGTERM)
        try:
            consumer.communicate(timeout=1)
        except subprocess.TimeoutExpired:
            os.killpg(consumer.pid, signal.SIGKILL)
            consumer.communicate()
        return 30, "Gitea token update outcome is uncertain; do not retry automatically."
    if not supplied:
        return 30, "Gitea token supply failed; outcome is uncertain; do not retry automatically."
    if consumer.returncode != 0:
        code = consumer.returncode if consumer.returncode in (2, 20, 30, 40) else 30
        return code, "Gitea token consumer failed; do not retry automatically."
    try:
        receipt = json.loads(stdout)
        if receipt != {"instanceId": "fake", "tokenSet": True, "storedMatchesInput": True}:
            raise ValueError()
    except Exception:
        return 30, "Gitea token receipt rejected; outcome is uncertain."
    return 0, json.dumps(receipt)


if __name__ == "__main__":
    result, message = drive(sys.argv[1], sys.argv[2], sys.argv[3:])
    print(message)
    sys.exit(result)
