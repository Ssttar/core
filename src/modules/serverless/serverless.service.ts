import { Injectable, Logger } from '@nestjs/common'
import { isURL } from 'class-validator'
import fs, { mkdir, stat } from 'fs/promises'
import { cloneDeep } from 'lodash'
import { InjectModel } from 'nestjs-typegoose'
import { join } from 'path'
import { nextTick } from 'process'
import { DATA_DIR, NODE_REQUIRE_PATH } from '~/constants/path.constant'
import { AssetService } from '~/processors/helper/helper.asset.service'
import { HttpService } from '~/processors/helper/helper.http.service'
import { UniqueArray } from '~/ts-hepler/unique'
import { safePathJoin } from '~/utils'
import { safeEval } from '~/utils/safe-eval.util'
import { isBuiltinModule } from '~/utils/sys.util'
import type PKG from '../../../package.json'
import { SnippetModel } from '../snippet/snippet.model'
import {
  FunctionContextRequest,
  FunctionContextResponse,
} from './function.types'

@Injectable()
export class ServerlessService {
  constructor(
    @InjectModel(SnippetModel)
    private readonly snippetModel: MongooseModel<SnippetModel>,
    private readonly assetService: AssetService,
    private readonly httpService: HttpService,
  ) {
    nextTick(() => {
      // Add /includes/plugin to the path, also note that we need to support
      //   `require('../hello.js')`. We can do that by adding /includes/plugin/a,
      //   /includes/plugin/a/b, etc.. to the list
      mkdir(NODE_REQUIRE_PATH, { recursive: true }).then(async () => {
        const pkgPath = join(NODE_REQUIRE_PATH, 'package.json')

        const isPackageFileExist = await stat(pkgPath)
          .then(() => true)
          .catch(() => false)

        if (!isPackageFileExist) {
          await fs.writeFile(
            pkgPath,
            JSON.stringify({ name: 'modules' }, null, 2),
          )
        }
      })

      module.paths.push(NODE_REQUIRE_PATH)

      // if (isDev) {
      //   console.log(module.paths)
      // }
    })
  }

  public get model() {
    return this.snippetModel
  }
  async injectContextIntoServerlessFunctionAndCall(
    model: SnippetModel,
    context: { req: FunctionContextRequest; res: FunctionContextResponse },
  ) {
    const { raw: functionString } = model
    const logger = new Logger('ServerlessFunction/' + model.name)
    const document = await this.model.findById(model.id)
    const globalContext = {
      context: {
        // inject app req, res
        ...context,
        ...context.res,
        query: context.req.query,
        headers: context.req.headers,
        params: context.req.params,

        model,
        document,
        name: model.name,
        reference: model.reference,

        // TODO
        // write file to asset
        writeAsset: async (
          path: string,
          data: any,
          options: Parameters<typeof fs.writeFile>[2],
        ) => {
          return await this.assetService.writeUserCustomAsset(
            safePathJoin(path),
            data,
            options,
          )
        },
        // read file to asset
        readAsset: async (
          path: string,
          options: Parameters<typeof fs.readFile>[1],
        ) => {
          return await this.assetService.getAsset(safePathJoin(path), options)
        },
      },
      // inject global
      __dirname: DATA_DIR,

      // inject some zx utils
      fetch,

      // inject Global API
      Buffer,

      // inject logger
      console: logger,
      logger,

      require: (() => {
        const __require = (id: string) => {
          const module = require(id)

          return cloneDeep(module)
        }

        const __requireNoCache = (id: string) => {
          delete require.cache[require.resolve(id)]
          const module = require(id)

          return cloneDeep(module)
        }

        async function $require(
          this: ServerlessService,
          id: string,
          useCache = true,
        ) {
          if (!id || typeof id !== 'string') {
            throw new Error('require id is not valid')
          }

          // 1. if is remote module
          if (
            isURL(id, { protocols: ['http', 'https'], require_protocol: true })
          ) {
            const text = await this.httpService.getAndCacheRequest(id)
            return await safeEval(`${text}; return module.exports`, {
              exports: {},
              module: {
                exports: null,
              },
            })
          }

          // 2. if application third part lib

          const allowedThirdPartLibs: UniqueArray<
            (keyof typeof PKG.dependencies)[]
          > = [
            'algoliasearch',
            'axios-retry',
            'axios',
            'class-transformer',
            'class-validator',
            'dayjs',
            'ejs',
            'html-minifier',
            'image-size',
            'isbot',
            'js-yaml',
            'jsdom',
            'jszip',
            'lodash',
            'marked',
            'nanoid',
            'qs',
            'rxjs',
            'snakecase-keys',
            'ua-parser-js',
            'xss',
          ]

          const trustPackagePrefixes = ['@innei/', '@mx-space/', 'mx-function-']

          if (
            allowedThirdPartLibs.includes(id as any) ||
            trustPackagePrefixes.some((prefix) => id.startsWith(prefix))
          ) {
            return useCache ? __require(id) : __requireNoCache(id)
          }

          // 3. mock built-in module

          const mockModules = {
            fs: {
              writeFile: globalContext.context.writeAsset,
              readFile: globalContext.context.readAsset,
            },
          }

          if (Object.keys(mockModules).includes(id)) {
            return mockModules[id]
          }

          // fin. is built-in module
          const module = isBuiltinModule(id, [
            'fs',
            'os',
            'child_process',
            'sys',
          ])
          if (!module) {
            throw new Error(`cannot require ${id}`)
          } else {
            return __require(id)
          }
        }

        return $require.bind(this)
      })(),
      process: {
        env: Object.freeze({ ...process.env }),
        nextTick: process.nextTick,
      },
    }

    return await safeEval(
      `${functionString}; return handler(context, require)`,
      { ...globalContext, global: globalContext, globalThis: globalContext },
    )
  }

  async isValidServerlessFunction(raw: string) {
    try {
      return safeEval(`
    ${raw}
    // 验证 handler 是否存在并且是函数
    return typeof handler === 'function'
    `)
    } catch (e) {
      console.error(e.message)
      return false
    }
  }
}