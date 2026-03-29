# Maple Signal Radar

A fork of follow-builders, redesigned for people who don't just want an AI news digest — they want a decision system.

## What changed

Instead of outputting a generic builder digest, this fork reframes the workflow into a signal radar for:
- content opportunities for X
- topic opportunities for Xiaohongshu
- product / agent / workflow signals worth paying attention to
- concrete next actions

## Core idea

The original repo got one important thing right: central feed + local remix + scheduled delivery.

This fork keeps that skeleton, but changes the last mile:
- from "what happened" to "why this matters"
- from "summary" to "signal extraction"
- from "digest" to "content + product decisions"

## New config directions

The config schema now supports:
- `focusTopics`
- `contentGoals`
- `outputSections`
- `scoring`

These fields are meant to tune the remixing behavior around your own priorities.

## Suggested use case

Use this if you want one recurring output that helps you answer:
- what should I pay attention to today?
- what can I write on X?
- what can become a Xiaohongshu post?
- what should influence my product thinking?
- what should I do next?

## Status

This is a working first-pass fork. The feed layer is still inherited from the original project. The biggest next step is making sources more customizable and adding explicit scoring in the preparation/remix pipeline.

## Credits

Original project: https://github.com/zarazhangrui/follow-builders
Fork direction and adaptation: Maple-style signal radar