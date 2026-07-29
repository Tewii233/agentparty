#!/usr/bin/env python3
"""Stop-hook spike 共存 + 变异实测（macmini #1744.4）。
单 dispatcher 与 sibling hooks 共存跑一段场景，断言：
  - 每次事件每个 hook 恰好命中一次（无重复消费）；
  - 同一 delivery 只被 claim 一次、ack 一次。
再做变异：重复注册 dispatcher / 删分派 / 残留旧 Stop(独立 state) / ack 门失效——断言必须变红。
python3 test_coexistence.py （全绿 exit 0）
"""
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DISP = os.path.join(HERE, "dispatcher.py")
_n = {"pass": 0, "fail": 0}


def ok(cond, label):
    if cond:
        _n["pass"] += 1; print(f"  ✓ {label}")
    else:
        _n["fail"] += 1; print(f"  ✗ FAIL: {label}")


def write_sibling(path, label):
    open(path, "w").write(
        "#!/usr/bin/env python3\n"
        "import json,sys,os\n"
        "try: ev=json.load(sys.stdin)\n"
        "except Exception: ev={}\n"
        f"rec={{'role':'sibling','label':'{label}','invocation_id':os.environ.get('SPIKE_INVOCATION_ID'),'event':ev.get('hook_event_name')}}\n"
        "open(os.environ['SPIKE_TRACE_PATH'],'a').write(json.dumps(rec)+chr(10))\n"
        "print('{}')\n")
    os.chmod(path, 0o755)


def write_mock_party(path, seq, did):
    open(path, "w").write(
        "#!/bin/sh\nsince=0\n"
        'while [ $# -gt 0 ]; do case "$1" in --since) since="$2"; shift;; esac; shift; done\n'
        f'if [ "$since" -lt {seq} ]; then\n'
        f"printf '%s\\n' '{json.dumps({'seq': seq, 'kind': 'message', 'sender': {'name': 'a'}, 'mentions': ['Evan_Clauder'], 'delivery_id': did, 'body': 'hi'})}'\n"
        "fi\n")
    os.chmod(path, 0o755)


def invoke(cmd, event, trace, statedir, party, invid, transcript=None):
    env = {**os.environ, "SPIKE_TRACE_PATH": trace, "SPIKE_STATE_DIR": statedir, "SPIKE_PARTY_BIN": party,
           "SPIKE_SELF_NAME": "Evan_Clauder", "SPIKE_INVOCATION_ID": invid}
    ev = dict(event)
    if transcript:
        ev["transcript_path"] = transcript
    return subprocess.run(cmd, input=json.dumps(ev), text=True, capture_output=True, env=env)


def parse(trace):
    out = []
    for l in open(trace):
        l = l.strip()
        if l:
            try:
                out.append(json.loads(l))
            except Exception:
                pass
    return out


def make_transcript(d, nonce):
    tp = os.path.join(d, "transcript.jsonl")
    open(tp, "w").write(
        json.dumps({"type": "user", "message": {"role": "user", "content": f"x AP_INBOX:{nonce} y"}}) + "\n" +
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": "ok"}}) + "\n")
    return tp


def run_scenario(hooks):
    """hooks: list of (label, cmd, statedir). 共享 trace + 各自 state（stale 用独立 state 模拟）。
    场景: SessionStart → Stop(有消息 D1) → Stop(confirm, 带含 nonce+assistant 的 transcript)。"""
    d = tempfile.mkdtemp()
    trace = os.path.join(d, "trace.jsonl")
    party = os.path.join(d, "party.sh"); write_mock_party(party, 501, "D1")
    ev_seq = [("e0", {"hook_event_name": "SessionStart", "session_id": "S1"}, False),
              ("e1", {"hook_event_name": "Stop", "session_id": "S1", "stop_hook_active": False}, False),
              ("e2", {"hook_event_name": "Stop", "session_id": "S1", "stop_hook_active": True}, True)]
    for ev_idx, event, is_confirm in ev_seq:
        for label, cmd, sd in hooks:
            transcript = None
            if is_confirm and label.startswith("dispatcher"):
                try:
                    pend = json.load(open(os.path.join(sd, "spike-state.json"))).get("pending") or {}
                    if pend.get("nonce"):
                        transcript = make_transcript(d, pend["nonce"])
                except Exception:
                    pass
            invoke(cmd, event, trace, sd, party, f"{ev_idx}:{label}", transcript)
    return parse(trace)


def dispatcher_invocations_per_event(trace):
    """dispatcher 每事件命中次数：按 invocation_id 前缀 e#: 分组，数 dispatcher 行。"""
    per = {}
    for t in trace:
        inv = t.get("invocation_id") or ""
        if t.get("role") != "sibling" and inv:  # dispatcher 行有 outcome、无 role=sibling
            ev = inv.split(":")[0]
            per[ev] = per.get(ev, 0) + 1
    return per


def claims(trace):
    return [t for t in trace if str(t.get("outcome", "")).startswith("block:claim")]


def acks(trace):
    return [t for t in trace if t.get("acked_id")]


D = tempfile.mkdtemp()
sibA = os.path.join(D, "sibA.py"); write_sibling(sibA, "sibA")
sibB = os.path.join(D, "sibB.py"); write_sibling(sibB, "sibB")
DISPCMD = [sys.executable, DISP]


def statedir():
    return tempfile.mkdtemp()


print("[基线: dispatcher + 两 sibling 共存]")
sd = statedir()
tr = run_scenario([("dispatcher", DISPCMD, sd), ("sibA", [sys.executable, sibA], sd), ("sibB", [sys.executable, sibB], sd)])
per = dispatcher_invocations_per_event(tr)
ok(all(v == 1 for v in per.values()) and set(per) == {"e0", "e1", "e2"}, f"dispatcher 每事件恰好命中一次 {per}")
sibs = [t for t in tr if t.get("role") == "sibling"]
ok(len([t for t in sibs if t["label"] == "sibA"]) == 3 and len([t for t in sibs if t["label"] == "sibB"]) == 3, "每 sibling 每事件命中一次(共 3)")
ok(len(claims(tr)) == 1 and claims(tr)[0]["delivery_id"] == "D1", f"D1 恰好 claim 一次 {[c['outcome'] for c in claims(tr)]}")
ok(len(acks(tr)) == 1 and acks(tr)[0]["acked_id"] == "D1", f"D1 恰好 ack 一次 {[a['acked_id'] for a in acks(tr)]}")

print("[变异 M1: 重复注册 dispatcher(同 state) → 每事件命中 2 次 应变红]")
sd = statedir()
tr = run_scenario([("dispatcher", DISPCMD, sd), ("dispatcher2", DISPCMD, sd)])
per = dispatcher_invocations_per_event(tr)
ok(any(v == 2 for v in per.values()), f"检测到 dispatcher 每事件命中 2 次(重复注册被抓) {per}")
ok(len(claims(tr)) == 1, "同 state 下重复注册仍只 claim 一次(去重防御生效)——但命中次数异常已被上一条抓")

print("[变异 M2: 删分派(无 dispatcher) → 0 claim 应变红]")
sd = statedir()
tr = run_scenario([("sibA", [sys.executable, sibA], sd)])
ok(len(claims(tr)) == 0, "无 dispatcher → D1 从未被 claim(删分派被抓)")

print("[变异 M3: 残留旧 Stop(独立 state) → 2 claim 应变红]")
sdA, sdB = statedir(), statedir()
tr = run_scenario([("dispatcher", DISPCMD, sdA), ("dispatcher_stale", DISPCMD, sdB)])
ok(len(claims(tr)) == 2, f"两个独立 state 的 dispatcher 各 claim 一次=D1 被 claim 2 次(残留旧注册被抓) {len(claims(tr))}")

print("[变异 M4: ack 门失效 → 无 assistant 的 transcript 不应 ack]")
# 正常：confirm Stop 若 transcript 里注入后【无】assistant → 不 ack（门有效）；
# 变异(去掉 confirm_turn 门)会误 ack。这里用真 dispatcher + 缺 assistant 的 transcript 验门有效。
d = tempfile.mkdtemp(); sd = statedir()
trace = os.path.join(d, "t.jsonl"); party = os.path.join(d, "p.sh"); write_mock_party(party, 501, "D1")
invoke(DISPCMD, {"hook_event_name": "SessionStart", "session_id": "S1"}, trace, sd, party, "e0:d")
invoke(DISPCMD, {"hook_event_name": "Stop", "session_id": "S1", "stop_hook_active": False}, trace, sd, party, "e1:d")
pend = json.load(open(os.path.join(sd, "spike-state.json")))["pending"]
# transcript: 只有含 nonce 的 user、【无】后续 assistant
bad_tp = os.path.join(d, "bad.jsonl")
open(bad_tp, "w").write(json.dumps({"type": "user", "message": {"content": f"AP_INBOX:{pend['nonce']}"}}) + "\n")
invoke(DISPCMD, {"hook_event_name": "Stop", "session_id": "S1", "stop_hook_active": True, "transcript_path": bad_tp}, trace, sd, party, "e2:d")
st = json.load(open(os.path.join(sd, "spike-state.json")))
ok(st["pending"] is not None and st["cursor"] == 0, "注入后无 assistant 的 transcript → 不 ack、pending 留存(ack 门有效；去门=变异会误 ack)")

print(f"\n=== {_n['pass']} passed, {_n['fail']} failed ===")
sys.exit(1 if _n["fail"] else 0)
