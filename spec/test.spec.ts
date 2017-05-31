import { Zat, IoSpy, StepMock, StepResponse, customMatchers, stringToBytes, hex16, Compiler, CompiledProg, Z80 } from 'zat';
import 'zat/lib/matchers';

function bytesToString(bytes: number[]): string {
    let str = '';
    for (let byte of bytes) {
        str += String.fromCharCode(byte);
    }
    return str;
}

function getNullTerminatedString(zat: Zat, start: number) {
    let str = '';
    while (zat.memory[start] !== 0) {
        str += String.fromCharCode(zat.memory[start++]);
    }
    return str;
}

describe('z80monitor', function() {
    let zat: Zat;
    let prog: CompiledProg;

    beforeAll(function() {
        prog = new Compiler().compileFile('src/z80monitor.z80');
    });

    beforeEach(function() {
        jasmine.addMatchers(customMatchers as any);

        zat = new Zat();
        zat.defaultCallSp = 0xFF00;
    });

    it('should write a line', function() {
        zat.loadProg(prog);

        zat.load('Hello\0', 0x5000);
        let ioSpy = new IoSpy(zat)
            .onIn(9, 0)
            .onOut(8, 'H')
            .onIn(9, 0)
            .onOut(8, 'e')
            .onIn(9, 0)
            .onOut(8, 'l')
            .onIn(9, 0)
            .onOut(8, 'l')
            .onIn(9, 0)
            .onOut(8, 'o');
        zat.onIoWrite = ioSpy.writeSpy();
        zat.onIoRead = ioSpy.readSpy();
        zat.z80.hl = 0x5000;
        zat.call('write_line');
        expect(ioSpy).toBeComplete();
    });

    it('should read a character', function() {
        zat.loadProg(prog);

        let ioSpy = new IoSpy(zat).onIn([9, '\xff\xff\0'], [8, 65]);
        zat.onIoRead = ioSpy.readSpy();
        zat.call('read_char');
        expect(zat.z80.a).toEqual(65);
        expect(ioSpy).toBeComplete();
    });

    it('should sound bell', function() {
        zat.loadProg(prog);

        const values = [];
        let count = 0;
        zat.onMemRead = (addr) => {
            if (addr == zat.getAddress('sound_bell1')) {
                count++;
            }
            return undefined;
        }
        zat.onIoWrite = (port, value) => {
            values.push([port & 0xff, value]);
        }
        zat.call('sound_bell');
        expect(values).toEqual([[6, 0xff], [6, 0]]);
        expect(count).toEqual(0x100 * 0x10);
    });

    it('should read and write', function() {
        zat.compile(`
start:
    ld a,1
    out (5),a
    in a,(6)
    out (7),a
    in a,(8)
    ld a,100
    out (1),a
    out (2),a
    in a,(2)
    in a,(2)
    out (1),a
    ret
        `);
        const ioSpy = new IoSpy(zat)
            .onOut(5, 1)
            .onIn(6, 27)
            .onOut(7, 27)
            .onIn(8, 11)
            .onOut([1, 100], [2, 100])
            .onIn([2, 1], [2, 2])
            .onOut(1, 2)
        zat.onIoRead = ioSpy.readSpy();
        zat.onIoWrite = ioSpy.writeSpy();
        zat.call('start');
        expect(ioSpy).toBeComplete();
    });

    it('should read a line', function() {
        zat.loadProg(prog);

        // Create two separate spies, so that the order of reads and writes doesn't matter.
        // It does, but I'm trying to test the bigger picture. Can do the order in another test.
        const readSpy = new IoSpy(zat)
            .onIn('ft245', '\x08heg\x08llo\r') // add some deletes in here
            .readSpy();
        const writeSpy = new IoSpy(zat)
            // the first delete should ring the bell, as the buffer is empty
            .onOut(['bell', [0xff, 0]], ['ft245', 'heg\x08llo\r'])
            .writeSpy();
        zat.onIoRead = (port) => {
            // If it's the ftdi_status port, always return 0 (ready)
            if ((port & 0xff) === zat.getAddress('ft245_status')) {
                return 0;
            }
            // ...otherwise use the spy
            return readSpy(port);
        }
        zat.onIoWrite = writeSpy;
        zat.call('read_line');
        expect(zat.getMemory('line', 6)).toEqual(stringToBytes('hello\0'));
    });

    it('should read a line - details', function() {
        zat.loadProg(prog);

        const ioSpy = new IoSpy(zat)
            .onIn(['ft245_status', 0], ['ft245', 8]) // read a backspace
            .onOut(['bell', [0xff, 0]]) // sound bell
            .onIn(['ft245_status', 0], ['ft245', 'h'], ['ft245_status', 0]) // read 'h', check we can write
            .onOut(['ft245', 'h']) // write 'h'
            .onIn(['ft245_status', 0], ['ft245', '\r'], ['ft245_status', 0]) // read CR, check we can write
            .onOut(['ft245', '\r'])  // write CR

        zat.onIoRead = ioSpy.readSpy();
        zat.onIoWrite = ioSpy.writeSpy();
        zat.call('read_line');
        expect(zat.getMemory('line', 2)).toEqual(stringToBytes('h\0'));
    });

    it('should recall last line', function() {
        zat.loadProg(prog);

        zat.load('hello\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.mockCall('write_line', function() {
            zat.z80.hl = zat.z80.hl + 5;
        });
        let index = 0;
        zat.mockCall('read_char', function() {
            zat.z80.a = [3, 13][index++]
        });
        zat.call('read_line');

        expect(zat.getMemory('line', 6)).toEqual(stringToBytes('hello\0'));
    });

    it('should find first string', function() {
        zat.loadProg(prog);

        zat.load('HELP\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_help'));
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 'HELP'.length);
    });

    it('should find second string', function() {
        zat.loadProg(prog);

        zat.load('PEEK\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_peek'));
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 'PEEK'.length);
    });

    it('should find second string, terminated by space', function() {
        zat.loadProg(prog);

        zat.load('PEEK ', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_peek'));
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 'PEEK'.length);
    });

    it('should fail to find string', function() {
        zat.loadProg(prog);

        zat.load('WIBBLE\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_error'));
    });

    it('should fail to find short string', function() {
        zat.loadProg(prog);

        zat.load('HEL ', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_error'));
    });

    it('should fail to string which almost matches first string', function() {
        zat.loadProg(prog);

        zat.load('HELP! ', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_helpling'));
    });

    it('should fail to find no string', function() {
        zat.loadProg(prog);

        zat.load(' ', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_error'));
    });

    it('should fail to find incomplete string', function() {
        zat.loadProg(prog);

        zat.load('HELPER\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_error'));
    });

    it('should loop', function() {
        zat.loadProg(prog);

        let called = false;
        zat.mockCall('read_line', () => {
            zat.load('HELP\0', 'line');
        });
        zat.mockCall('call_hl', () => {
            called = true;
            expect(zat.z80.hl).toBe(zat.getAddress('cmd_help'));
        });
        zat.setBreakpoint('end_loop');
        zat.call('loop', {steps: 200});

        expect(called).toBe(true);
    });

    it('should make letters upper case', function() {
        zat.loadProg(prog);

        zat.z80.a = '`'.charCodeAt(0);
        zat.call('to_upper');
        expect(zat.z80.a).toBe('`'.charCodeAt(0));

        zat.z80.a = 'a'.charCodeAt(0);
        zat.call('to_upper');
        expect(zat.z80.a).toBe('A'.charCodeAt(0));

        zat.z80.a = 'b'.charCodeAt(0);
        zat.call('to_upper');
        expect(zat.z80.a).toBe('B'.charCodeAt(0));

        zat.z80.a = 'y'.charCodeAt(0);
        zat.call('to_upper');
        expect(zat.z80.a).toBe('Y'.charCodeAt(0));

        zat.z80.a = 'z'.charCodeAt(0);
        zat.call('to_upper');
        expect(zat.z80.a).toBe('Z'.charCodeAt(0));

        zat.z80.a = '{'.charCodeAt(0);
        zat.call('to_upper');
        expect(zat.z80.a).toBe('{'.charCodeAt(0));
    });

    it('should find lower case string', function() {
        zat.loadProg(prog);

        zat.load('peek\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_peek'));
    });

    it('should convert bcd to number string', function() {
        zat.loadProg(prog);

        zat.z80.a = 0x45;
        zat.z80.hl = zat.getAddress('line');
        zat.call('bcd_to_num');

        expect(zat.getMemory('line', 2)).toEqual(stringToBytes('45'));
    });

    it('should convert string to bcd', function() {
        zat.loadProg(prog);

        zat.load('45', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('num_to_bcd');

        expect(zat.z80.a).toBe(0x45);
        expect(zat.z80.e).toBe(0);
        expect(zat.z80.d).toBe(45);
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 2);

        zat.load('00', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('num_to_bcd');

        expect(zat.z80.a).toBe(0x00);
        expect(zat.z80.e).toBe(0);
        expect(zat.z80.d).toBe(0);
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 2);

        zat.load('99', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('num_to_bcd');

        expect(zat.z80.a).toBe(0x99);
        expect(zat.z80.e).toBe(0);
        expect(zat.z80.d).toBe(99);
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 2);
    });

    it('should fail to convert string to bcd', function() {
        zat.loadProg(prog);

        zat.load('/5', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('num_to_bcd');

        expect(zat.z80.e).toBe(1);

        zat.load(':5', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('num_to_bcd');

        expect(zat.z80.e).toBe(1);

        zat.load('5/', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('num_to_bcd');

        expect(zat.z80.e).toBe(1);

        zat.load('5:', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('num_to_bcd');

        expect(zat.z80.e).toBe(1);
    });

    it('should skip spaces', function() {
        zat.loadProg(prog);

        zat.load('BOB', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('skip_spaces');

        expect(zat.z80.c).toBe(0);
        expect(zat.z80.hl).toBe(zat.getAddress('line'));

        zat.load(' BOB', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('skip_spaces');

        expect(zat.z80.c).toBe(1);
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 1);
    });

    it('should parse time', function() {
        zat.loadProg(prog);

        var writeLineCalled = false;
        zat.mockStep('write_line', () => {
                writeLineCalled = true;
            });

        zat.load('00:00:00', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_time');

        expect(writeLineCalled).toBe(false);
        expect(zat.getMemory('bcd_time', 3)).toEqual([0x00, 0x00, 0x00]);

        writeLineCalled = false;
        zat.load('00:00:59', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_time');

        expect(writeLineCalled).toBe(false);
        expect(zat.getMemory('bcd_time', 3)).toEqual([0x00, 0x00, 0x59]);

        writeLineCalled = false;
        zat.load('00:00:60', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_time');

        expect(writeLineCalled).toBe(true);

        writeLineCalled = false;
        zat.load('00:59:59', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_time');

        expect(writeLineCalled).toBe(false);
        expect(zat.getMemory('bcd_time', 3)).toEqual([0x00, 0x59, 0x59]);
    
        writeLineCalled = false;
        zat.load('00:60:00', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_time');

        expect(writeLineCalled).toBe(true);

        writeLineCalled = false;
        zat.load('23:59:59', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_time');

        expect(writeLineCalled).toBe(false);
        expect(zat.getMemory('bcd_time', 3)).toEqual([0x23, 0x59, 0x59]);

        writeLineCalled = false;
        zat.load('24:00:00', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_time');

        expect(writeLineCalled).toBe(true);
    });

    it('should parse hex number', function() {
        zat.loadProg(prog);

        zat.load('0\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0);
        expect(zat.z80.e).toBe(0);

        zat.load('9\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0x9);
        expect(zat.z80.e).toBe(0);

        zat.load('a\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0xa);
        expect(zat.z80.e).toBe(0);

        zat.load('A\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0xa);
        expect(zat.z80.e).toBe(0);

        zat.load('F\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0xf);
        expect(zat.z80.e).toBe(0);

        zat.load('G\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.e).toBe(1);

        zat.load('G\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.e).toBe(1);

        zat.load('00\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0);
        expect(zat.z80.e).toBe(0);

        zat.load('FF\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0xff);
        expect(zat.z80.e).toBe(0);

        zat.load('FFFF\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0xffff);
        expect(zat.z80.e).toBe(0);

        zat.load('BABE\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.bc).toBe(0xbabe);
        expect(zat.z80.e).toBe(0);

        zat.load('BABEE\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('parse_hex');

        expect(zat.z80.e).toBe(1);
    });

    it('should format 2 digit hex', function() {
        zat.loadProg(prog);

        zat.load('00X', 'line')

        zat.z80.a = 0x12;
        zat.z80.hl = zat.getAddress('line');
        zat.call('format_hex_2');

        expect(zat.getMemory('line', 3)).toEqual(stringToBytes('12X'));
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 2);

        zat.z80.a = 0xaf;
        zat.z80.hl = zat.getAddress('line');
        zat.call('format_hex_2');

        expect(zat.getMemory('line', 3)).toEqual(stringToBytes('AFX'));
        expect(zat.z80.hl).toBe(zat.getAddress('line') + 2);
    });

    it('should dump memory', function() {
        zat.loadProg(prog);

        zat.load([0,1,2,3,4,5,6,7,0xf,0xe,0xd,0xc,0xb,0xa,9,8], 0xf000);
        zat.load([0xf,0xe,0xd,0xc,0xb,0xa,9,8,0,1,2,3,4,5,6,7], 0xf010);
        zat.load(' f000,1f\0', 'line');
        let called = 0;
        zat.mockCall('write_line', function() {
            expect(getNullTerminatedString(zat, zat.getAddress('dumpline')))
                .toBe(['F000 00 01 02 03 04 05 06 07 0F 0E 0D 0C 0B 0A 09 08 ................\n',
                'F010 0F 0E 0D 0C 0B 0A 09 08 00 01 02 03 04 05 06 07 ................\n'][called++]);
        })
        zat.z80.de = zat.getAddress('line');

        zat.call('cmd_dump');

        expect(called).toBe(2);
    });

    it('should dump memory on 16 byte page boundaries', function() {
        zat.loadProg(prog);

        zat.load([0,1,2,3,4,5,6,7,0xf,0xe,0xd,0xc,0xb,0xa,9,8], 0xf000);
        zat.load([0xf,0xe,0xd,0xc,0xb,0xa,9,8,0,1,2,3,4,5,6,7], 0xf010);
        zat.load(' f005,15\0', 'line');
        let called = 0;
        zat.mockCall('write_line', function() {
            expect(getNullTerminatedString(zat, zat.getAddress('dumpline')))
                .toBe(['F000 00 01 02 03 04 05 06 07 0F 0E 0D 0C 0B 0A 09 08 ................\n',
                'F010 0F 0E 0D 0C 0B 0A 09 08 00 01 02 03 04 05 06 07 ................\n'][called++]);
        })
        zat.z80.de = zat.getAddress('line');

        zat.call('cmd_dump');

        expect(called).toBe(2);
    });

    it('should dump ascii chars', function() {
        zat.loadProg(prog);

        zat.load(stringToBytes('This is a test. '), 0xf000);
        zat.load([0x30,0x2f,0x7e,0x7f,0x31,0x32,0x33,0x34, 0x41,0x42,0x43,0x44,0x45,0x46,0x47,0x48], 0xf010);
        zat.load(' f005,15\0', 'line');
        let called = 0;
        zat.mockCall('write_line', function() {
            expect(getNullTerminatedString(zat, zat.getAddress('dumpline')))
                .toBe(['F000 54 68 69 73 20 69 73 20 61 20 74 65 73 74 2E 20 This is a test. \n',
                'F010 30 2F 7E 7F 31 32 33 34 41 42 43 44 45 46 47 48 0/~.1234ABCDEFGH\n'][called++]);
        })
        zat.z80.de = zat.getAddress('line');

        zat.call('cmd_dump');

        expect(called).toBe(2);
    });

    it('should do an IN', function() {
        zat.loadProg(prog);

        let ioSpy = new IoSpy(zat)
            .onIn(0x10, 0x25);

        zat.onIoRead = ioSpy.readSpy();

        zat.load(' 10', 'line');
        zat.z80.de = zat.getAddress('line');
        let called = false;
        zat.mockStep('write_line', function() {
            expect(getNullTerminatedString(zat, zat.z80.hl))
                .toBe('25\n');
            called = true;
            return StepResponse.BREAK;
        });
        zat.call('cmd_in');

        expect(called).toBe(true);
    });
});