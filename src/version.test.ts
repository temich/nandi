import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { VERSION } from './version.ts'

describe('VERSION', () => {
  it('is a semver triple', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/)
  })
})
