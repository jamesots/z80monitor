import { Zat, IoSpy, StepMock, customMatchers, stringToBytes, hex16, Compiler, CompiledProg, Z80 } from 'zat';
import 'zat/lib/matchers';

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

    it('should find first string', function() {
        zat.loadProg(prog);

        zat.load('HELP\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_help'));
    });

    it('should find second string', function() {
        zat.loadProg(prog);

        zat.load('PEEK\0', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_peek'));
    });

    it('should find second string, terminated by space', function() {
        zat.loadProg(prog);

        zat.load('PEEK ', 'line');
        zat.z80.hl = zat.getAddress('line');
        zat.call('lookup_command');

        expect(zat.z80.de).toBe(zat.getAddress('cmd_peek'));
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
        zat.onStep = new StepMock(zat)
        .setFakeCall('read_line', () => {
            zat.load('HELP\0', 'line');
        })
        .setFakeCall('call_hl', () => {
            called = true;
            expect(zat.z80.hl).toBe(zat.getAddress('cmd_help'));
        })
        .setBreakpoint('end_loop')
        .mock();
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

});