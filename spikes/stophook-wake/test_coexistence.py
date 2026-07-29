#!/usr/bin/env python3
"""Stop-hook spike 共存 + 变异实测（macmini #1744.4 / #1759）。

方法学（macmini #1759 纠正）：把「每事件命中一次 / 同 delivery 只 claim&ack 一次」抽成
【单一 check_invariants(trace)→violations】。baseline 断言 violations==[]；每个变异【复用同一套
不变量】对变异拓扑跑一遍、断言 violations 非空且命中对应 INV —— 即"基线不变量在变异下真跑红"，
而不是直接断言 mutant 的坏症状"存在"(那样场景反而绿)。M4 用真代码变异(mutant dispatcher)自证。

python3 test_coexistence.py （全绿 exit 0）
"""
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

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
        "#!/usr/bin/env python3\nimport json,sys,os\n"
        "try: ev=json.load(sys.stdin)\nexcept Exception: ev={}\n"
        f"rec={{'role':'sibling','label':'{label}','invocation_id':os.environ.get('SPIKE_INVOCATION_ID'),'event':ev.get('hook_event_name')}}\n"
        "open(os.environ['SPIKE_TRACE_PATH'],'a').write(json.dumps(rec)+chr(10))\nprint('{}')\n")
    os.chmod(path, 0o755)


def write_mock_party(path, seq, did):
    open(path, "w").write(
        "#!/bin/sh\nsince=0\n"
        'while [ $# -gt 0 ]; do case "$1" in --since) since="$2"; shift;; esac; shift; done\n'
        f'if [ "$since" -lt {seq} ]; then\n'
        f"printf '%s\\n' '{json.dumps({'seq': seq, 'kind': 'message', 'sender': {'name': 'a'}, 'mentions': ['Evan_Clauder'], 'delivery_id': did, 'body': 'hi'})}'\nfi\n")
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
    tp = os.path.join(d, f"transcript_{nonce}.jsonl")
    open(tp, "w").write(
        json.dumps({"type": "user", "message": {"role": "user", "content": f"x AP_INBOX:{nonce} y"}}) + "\n" +
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": "ok"}}) + "\n")
    return tp


def run_scenario(hooks):
    """hooks: list of (label, cmd, statedir). 共享 trace。场景: SessionStart → Stop(有 D1) → Stop(confirm)。"""
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
    per = {}
    for t in trace:
        inv = t.get("invocation_id") or ""
        if t.get("role") != "sibling" and inv:
            per[inv.split(":")[0]] = per.get(inv.split(":")[0], 0) + 1
    return per


def claims(trace):
    return [t for t in trace if str(t.get("outcome", "")).startswith("block:claim")]


def acks(trace):
    return [t for t in trace if t.get("acked_id")]


def check_invariants(trace, events, deliveries):
    """基线不变量（baseline 与所有变异【复用同一套】）：返回 violations 列表(空=通过)。"""
    v = []
    per = dispatcher_invocations_per_event(trace)
    for ev in events:
        if per.get(ev, 0) != 1:
            v.append(f"INV1[{ev}]=dispatcher×{per.get(ev, 0)}!=1")
    cc = Counter(c["delivery_id"] for c in claims(trace))
    for did in deliveries:
        if cc.get(did, 0) != 1:
            v.append(f"INV2[{did}]=claim×{cc.get(did, 0)}!=1")
    ac = Counter(a["acked_id"] for a in acks(trace))
    for did in deliveries:
        if ac.get(did, 0) != 1:
            v.append(f"INV3[{did}]=ack×{ac.get(did, 0)}!=1")
    return v


D = tempfile.mkdtemp()
sibA = [sys.executable, os.path.join(D, "sibA.py")]; write_sibling(sibA[1], "sibA")
sibB = [sys.executable, os.path.join(D, "sibB.py")]; write_sibling(sibB[1], "sibB")
DISPCMD = [sys.executable, DISP]
EVENTS, DELIV = ["e0", "e1", "e2"], ["D1"]


def sd():
    return tempfile.mkdtemp()


print("[基线: 复用不变量应全过]")
one = sd()
tr = run_scenario([("dispatcher", DISPCMD, one), ("sibA", sibA, one), ("sibB", sibB, one)])
ok(check_invariants(tr, EVENTS, DELIV) == [], "baseline check_invariants → violations==[]")
sibs = [t for t in tr if t.get("role") == "sibling"]
ok(len([t for t in sibs if t["label"] == "sibA"]) == 3 and len([t for t in sibs if t["label"] == "sibB"]) == 3, "每 sibling 每事件命中一次")

print("[变异 M1 重复注册(同 state) → 复用不变量在变异拓扑上跑红(INV1)]")
tr = run_scenario([("dispatcher", DISPCMD, (o := sd())), ("dispatcher2", DISPCMD, o)])
vio = check_invariants(tr, EVENTS, DELIV)
ok(vio != [] and any("INV1" in x for x in vio), f"M1 → 同一套 check_invariants 跑红 {vio}")

print("[变异 M2 删分派 → 复用不变量跑红(INV2 无 claim)]")
tr = run_scenario([("sibA", sibA, sd())])
vio = check_invariants(tr, EVENTS, DELIV)
ok(vio != [] and any("INV2" in x for x in vio), f"M2 → 同一套 check_invariants 跑红 {vio}")

print("[变异 M3 残留旧 Stop(独立 state) → 复用不变量跑红(INV2 双 claim)]")
tr = run_scenario([("dispatcher", DISPCMD, sd()), ("dispatcher_stale", DISPCMD, sd())])
vio = check_invariants(tr, EVENTS, DELIV)
ok(vio != [] and any("INV2" in x for x in vio), f"M3 → 同一套 check_invariants 跑红 {vio}")


def make_mutant():
    """真代码变异：把 try_ack 的 confirmed 恒置 True（ack 门失效）。"""
    src = open(DISP).read()
    mut = src.replace("state, acked_id = try_ack(event, state, confirmed)",
                      "state, acked_id = try_ack(event, state, True)")
    assert mut != src, "mutation 未应用（源已变？）"
    mp = os.path.join(tempfile.mkdtemp(), "dispatcher_mut.py")
    open(mp, "w").write(mut)
    return [sys.executable, mp]


def run_ackgate(disp_cmd):
    """场景: SessionStart, Stop(claim D1), Stop(confirm 但 transcript【无 assistant】=没真续跑)。
    真 dispatcher: turn 未确认 → 不 ack；mutant(门恒真): 误 ack。"""
    d = tempfile.mkdtemp(); trace = os.path.join(d, "t.jsonl")
    party = os.path.join(d, "p.sh"); write_mock_party(party, 501, "D1"); statedir = tempfile.mkdtemp()
    invoke(disp_cmd, {"hook_event_name": "SessionStart", "session_id": "S1"}, trace, statedir, party, "e0:d")
    invoke(disp_cmd, {"hook_event_name": "Stop", "session_id": "S1", "stop_hook_active": False}, trace, statedir, party, "e1:d")
    pend = json.load(open(os.path.join(statedir, "spike-state.json")))["pending"]
    bad_tp = os.path.join(d, "bad.jsonl")
    open(bad_tp, "w").write(json.dumps({"type": "user", "message": {"content": f"AP_INBOX:{pend['nonce']}"}}) + "\n")  # 无 assistant
    invoke(disp_cmd, {"hook_event_name": "Stop", "session_id": "S1", "stop_hook_active": True, "transcript_path": bad_tp}, trace, statedir, party, "e2:d")
    return json.load(open(os.path.join(statedir, "spike-state.json"))), parse(trace)


print("[变异 M4 真代码变异(ack 门恒真) → premature ack 自证]")
st_real, tr_real = run_ackgate(DISPCMD)
ok(acks(tr_real) == [] and st_real["cursor"] == 0 and st_real["pending"] is not None,
   "真 dispatcher + 无 assistant transcript → 0 ack、cursor 不动、pending 留存(门有效)")
st_mut, tr_mut = run_ackgate(make_mutant())
ok(acks(tr_mut) != [] and st_mut["cursor"] != 0,
   "mutant(ack门恒真) 同场景 → premature ack、cursor 推进(变异被自证可红)")

print(f"\n=== {_n['pass']} passed, {_n['fail']} failed ===")
sys.exit(1 if _n["fail"] else 0)
