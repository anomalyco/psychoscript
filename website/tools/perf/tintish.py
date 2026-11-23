# Finds expressions naga accepts and Chrome's compiler refuses: && and || mixed without parentheses (also & | ^, and shifts beside arithmetic).
import re, sys, subprocess, json
src = sys.argv[1]
out = subprocess.run(['bun','-e',f"import('{src}').then(m=>console.log(JSON.stringify({{shader:m.shader,glow:m.glowShader,sim:m.simShader,boss:m.bossShader}})))"],capture_output=True,text=True).stdout
bad = 0
for name, code in json.loads(out).items():
    if not code: continue
    code = re.sub(r'//[^\n]*', '', code)
    stack = [dict()]
    line = 1
    i = 0
    def note(op):
        global bad
        seen = stack[-1]
        seen[op] = line
        groups = [('&&','||'), ('&','|'), ('&','^'), ('|','^'), ('<<','+'), ('<<','-'), ('<<','*'), ('>>','+'), ('>>','*'), ('&&','&'), ('||','|'),('&&','|'),('||','&')]
        for a,b in groups:
            if a in seen and b in seen and op in (a,b):
                bad += 1
                print(f'{name}:{line}: mixes {a} and {b}: ' + code.split('\n')[line-1].strip()[:150])
    while i < len(code):
        c = code[i]; two = code[i:i+2]
        if c == '\n': line += 1
        elif c in '([': stack.append(dict())
        elif c in ')]':
            if len(stack) > 1: stack.pop()
        elif c in ';{},': stack[-1] = dict()
        elif two in ('&&','||','<<','>>') and not (two in ('<<','>>') and False):
            # ignore generics like array<vec4f, 5>> : shifts only counted when followed by space/digit
            if two in ('&&','||') or re.match(r'(<<|>>)\s*[\w(]', code[i:i+6]) and code[i-1] in ' w)':
                note(two)
            i += 1
        elif c in '&|^' : note(c)
        elif c in '+*' : stack[-1][c] = line
        i += 1
print('problems:', bad)
