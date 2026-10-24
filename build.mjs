import {build} from 'esbuild';await build({entryPoints:['src/index.ts'],outfile:'workbench.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
