/**
 * Unit tests for optional driver loading (src/fixtures/optional-package.ts),
 * plus guards that keep drivers optional: no top-level value import of a
 * driver anywhere in src/, and package.json in sync with FIXTURE_PACKAGES.
 */

import { packageCommand, packageManager } from '../../src/package-manager';
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MissingPackageError } from '../../src/errors';
import { FIXTURE_PACKAGES, isMissingPackage, loadOptional, packageNameOf } from '../../src/fixtures/optional-package';

const ROOT = path.resolve(import.meta.dirname, '../..');
const DRIVERS: string[] = [...new Set<string>(Object.values(FIXTURE_PACKAGES).flat())].sort();

test.describe('optional packages — helpers', () => {
    test('packageNameOf strips subpaths and keeps scopes', () => {
        expect(packageNameOf('mysql2/promise')).toBe('mysql2');
        expect(packageNameOf('kafkajs')).toBe('kafkajs');
        expect(packageNameOf('@scope/pkg/sub/path')).toBe('@scope/pkg');
    });

    test('isMissingPackage matches only a not-found error for that package', () => {
        const esm = Object.assign(new Error("Cannot find package 'kafkajs' imported from /x.js"), { code: 'ERR_MODULE_NOT_FOUND' });
        const cjs = Object.assign(new Error("Cannot find module 'kafkajs'"), { code: 'MODULE_NOT_FOUND' });
        const transitive = Object.assign(new Error("Cannot find package 'lz4' imported from /node_modules/kafkajs/x.js"), {
            code: 'ERR_MODULE_NOT_FOUND',
        });
        expect(isMissingPackage(esm, 'kafkajs')).toBe(true);
        expect(isMissingPackage(cjs, 'kafkajs')).toBe(true);
        expect(isMissingPackage(transitive, 'kafkajs')).toBe(false);
        expect(isMissingPackage(new Error("Cannot find package 'kafkajs'"), 'kafkajs')).toBe(false); // no code
        expect(isMissingPackage(null, 'kafkajs')).toBe(false);
    });
});

test.describe('optional packages — loadOptional', () => {
    test('loads an installed package, once', async () => {
        const a = await loadOptional<typeof import('otplib')>('otplib', 'otpClient');
        const b = await loadOptional<typeof import('otplib')>('otplib', 'otpClient');
        expect(typeof a.TOTP).toBe('function');
        expect(b).toBe(a);
    });

    test('a missing package becomes MissingPackageError with the install command', async () => {
        const err = await loadOptional('propmaster-no-such-driver/sub', 'fakeClient', ['propmaster-no-such-driver', 'peer-pkg']).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(MissingPackageError);
        if (!(err instanceof MissingPackageError)) return;
        expect(err.fixtureName).toBe('fakeClient');
        expect(err.packageName).toBe('propmaster-no-such-driver');
        expect(err.installCommand).toBe(packageCommand(packageManager(process.cwd()), 'install', ['propmaster-no-such-driver', 'peer-pkg']).join(' '));
        expect(err.message).toContain('The "fakeClient" fixture needs the "propmaster-no-such-driver" package');
        expect(err.cause).toBeDefined();
    });

    test('any other load failure is rethrown unchanged', async () => {
        const err = await loadOptional('data:text/javascript,throw new Error("native build broke")', 'fakeClient').catch((e: unknown) => e);
        expect(err).not.toBeInstanceOf(MissingPackageError);
        expect(String((err as Error).message)).toContain('native build broke');
    });
});

test.describe('optional packages — guards', () => {
    test('no file in src/ value-imports a driver at the top level', () => {
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const name of fs.readdirSync(dir)) {
                const full = path.join(dir, name);
                if (fs.statSync(full).isDirectory()) walk(full);
                else if (full.endsWith('.ts') && !full.includes(`${path.sep}cli${path.sep}`)) {
                    fs.readFileSync(full, 'utf8')
                        .split('\n')
                        .forEach((line, i) => {
                            const m = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/.exec(line);
                            if (m && DRIVERS.includes(packageNameOf(m[1]))) offenders.push(`${path.relative(ROOT, full)}:${i + 1}  ${line.trim()}`);
                        });
                }
            }
        };
        walk(path.join(ROOT, 'src'));
        expect(offenders, 'load drivers with loadOptional() instead').toEqual([]);
    });

    test('package.json declares every driver as an optional peer, and nothing as a runtime dependency', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(pkg.dependencies ?? {}).toEqual({});
        for (const d of DRIVERS) {
            expect(pkg.peerDependencies, d).toHaveProperty([d]);
            expect(pkg.peerDependenciesMeta?.[d], d).toEqual({ optional: true });
            expect(pkg.devDependencies, d).toHaveProperty([d]);
        }
        const optionalPeers = Object.keys(pkg.peerDependenciesMeta ?? {}).sort();
        expect(optionalPeers).toEqual(DRIVERS);
        expect(pkg.peerDependenciesMeta['@playwright/test']).toBeUndefined(); // Playwright stays required
    });
});
