"""A small JQL evaluator: enough of the language for the queries Obeya sends
and the ones a user is likely to type into a bar.

Supports AND / OR / NOT, parentheses, =, !=, ~, IN, NOT IN, IS [NOT] EMPTY,
openSprints() / closedSprints() / futureSprints(), cf[12345] and ORDER BY
(accepted and ignored). Unknown fields fail the way Jira does, with a 400.
"""
from __future__ import annotations

import re
from typing import Any, Callable, Optional

from . import data as d


class JqlError(Exception):
    pass


_TOKEN = re.compile(r"""
    \s*(?:
        (?P<str>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')
      | (?P<op>!=|!~|=|~|\(|\)|,)
      | (?P<word>cf\[\d+\]|[^\s()=!~,"']+)
    )""", re.X)


def tokenize(text: str) -> list[tuple[str, str]]:
    out, pos = [], 0
    text = text.rstrip()
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise JqlError(f"Error in the JQL Query: unexpected character at position {pos}.")
        pos = m.end()
        if m.group("str") is not None:
            out.append(("str", re.sub(r"\\(.)", r"\1", m.group("str")[1:-1])))
        elif m.group("op") is not None:
            out.append(("op", m.group("op")))
        else:
            out.append(("word", m.group("word")))
    return out


Predicate = Callable[[dict], bool]


class Parser:
    def __init__(self, dataset: "d.Dataset", text: str):
        self.ds = dataset
        self.toks = tokenize(text)
        self.i = 0

    # ---- token helpers ----

    def _peek(self) -> Optional[tuple[str, str]]:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def _kw(self, *words: str) -> bool:
        """Consume the given keywords if they come next."""
        for n, w in enumerate(words):
            t = self.toks[self.i + n] if self.i + n < len(self.toks) else None
            if not t or t[0] != "word" or t[1].upper() != w:
                return False
        self.i += len(words)
        return True

    def _op(self, op: str) -> bool:
        t = self._peek()
        if t and t == ("op", op):
            self.i += 1
            return True
        return False

    def _expect(self, op: str) -> None:
        if not self._op(op):
            raise JqlError(f"Error in the JQL Query: expecting '{op}'.")

    # ---- grammar ----

    def parse(self) -> Predicate:
        if self._peek() is None or self._peek_order():
            pred: Predicate = lambda issue: True
        else:
            pred = self._or()
        if self._kw("ORDER", "BY"):
            self.i = len(self.toks)
        if self._peek() is not None:
            raise JqlError(f"Error in the JQL Query: unexpected '{self._peek()[1]}'.")
        return pred

    def _peek_order(self) -> bool:
        t = self._peek()
        return bool(t and t[0] == "word" and t[1].upper() == "ORDER")

    def _or(self) -> Predicate:
        parts = [self._and()]
        while self._kw("OR"):
            parts.append(self._and())
        return (lambda issue: any(p(issue) for p in parts)) if len(parts) > 1 else parts[0]

    def _and(self) -> Predicate:
        parts = [self._not()]
        while self._kw("AND"):
            parts.append(self._not())
        return (lambda issue: all(p(issue) for p in parts)) if len(parts) > 1 else parts[0]

    def _not(self) -> Predicate:
        if self._kw("NOT"):
            inner = self._not()
            return lambda issue: not inner(issue)
        if self._op("("):
            inner = self._or()
            self._expect(")")
            return inner
        return self._clause()

    def _clause(self) -> Predicate:
        t = self._peek()
        if t is None or t[0] == "op":
            raise JqlError("Error in the JQL Query: expecting a field name.")
        self.i += 1
        getter = self._field(t[1])
        if self._kw("IS", "NOT", "EMPTY") or self._kw("IS", "NOT", "NULL"):
            return lambda issue: bool(getter(issue))
        if self._kw("IS", "EMPTY") or self._kw("IS", "NULL"):
            return lambda issue: not getter(issue)
        negate = False
        if self._kw("NOT", "IN"):
            negate, values = True, self._list(t[1])
        elif self._kw("IN"):
            values = self._list(t[1])
        elif self._op("="):
            values = [self._value(t[1])]
        elif self._op("!="):
            negate, values = True, [self._value(t[1])]
        elif self._op("~"):
            needle = self._value(t[1]).casefold()
            return lambda issue: any(needle in v for v in getter(issue))
        else:
            raise JqlError(f"Error in the JQL Query: expecting an operator after '{t[1]}'.")
        wanted = {str(v).casefold() for v in values}
        if negate:
            return lambda issue: not (getter(issue) & wanted)
        return lambda issue: bool(getter(issue) & wanted)

    def _list(self, field: str) -> list[str]:
        t = self._peek()
        if t and t[0] == "word" and t[1].lower() in _SPRINT_FUNCS:
            return self._value(field, many=True)
        self._expect("(")
        values = [self._value(field)]
        while self._op(","):
            values.append(self._value(field))
        self._expect(")")
        return values

    def _value(self, field: str, many: bool = False) -> Any:
        t = self._peek()
        if t is None or t[0] == "op":
            raise JqlError("Error in the JQL Query: expecting a value.")
        self.i += 1
        if t[0] == "word" and t[1].lower() in _SPRINT_FUNCS:
            self._expect("(")
            self._expect(")")
            ids = [str(s["id"]) for s in self.ds.sprints if s["state"] == _SPRINT_FUNCS[t[1].lower()]]
            return ids if many else (ids[0] if ids else "")
        if field.lower() in _KEY_FIELDS and not self.ds.by_key(t[1]):
            raise JqlError(f"An issue with key '{t[1]}' does not exist for field '{field}'.")
        return t[1]

    # ---- fields ----

    def _field(self, name: str) -> Callable[[dict], set[str]]:
        """Return a getter giving the issue's values for this field, case-folded."""
        key = name.strip().casefold()
        m = re.fullmatch(r"cf\[(\d+)\]", key)
        if m:
            key = f"customfield_{m.group(1)}"
        getter = _GETTERS.get(key)
        if getter is None:
            raise JqlError(f"Field '{name}' does not exist or you do not have permission to view it.")
        return lambda issue: {str(v).casefold() for v in getter(issue) if v not in (None, "")}


_SPRINT_FUNCS = {"opensprints": "active", "closedsprints": "closed", "futuresprints": "future"}
_KEY_FIELDS = {"key", "issuekey", "issue", "id", "parent", "epic link", "parent link",
               "cf[10101]", "cf[10102]"}


def _sprint_values(issue: dict) -> list[str]:
    return [str(s) for s in issue["sprints"]] + [f"Sprint {s}" for s in issue["sprints"]]


_GETTERS: dict[str, Callable[[dict], list]] = {
    "key": lambda i: [i["key"], i["id"]],
    "issuekey": lambda i: [i["key"], i["id"]],
    "issue": lambda i: [i["key"], i["id"]],
    "id": lambda i: [i["key"], i["id"]],
    "project": lambda i: [i["project"]],
    "issuetype": lambda i: [i["type"]],
    "type": lambda i: [i["type"]],
    "status": lambda i: [i["status"]],
    "statuscategory": lambda i: [d.STATUSES[i["status"]], d.CATEGORY_NAMES[d.STATUSES[i["status"]]]],
    "summary": lambda i: [i["summary"]],
    "text": lambda i: [i["summary"]],
    "parent": lambda i: [i["parent"]],
    "epic link": lambda i: [i["epic"]],
    d.EPIC_LINK: lambda i: [i["epic"]],
    "parent link": lambda i: [i["parent_link"]],
    d.PARENT_LINK: lambda i: [i["parent_link"]],
    "sprint": _sprint_values,
    d.SPRINT: _sprint_values,
    "story points": lambda i: [i["points"]],
    d.STORY_POINTS: lambda i: [i["points"]],
    "program increment": lambda i: [i["pi"]],
    d.PI_FIELD: lambda i: [i["pi"]],
}


def search(dataset: "d.Dataset", jql: str) -> list[dict]:
    predicate = Parser(dataset, jql or "").parse()
    return [issue for issue in dataset.issues if predicate(issue)]
