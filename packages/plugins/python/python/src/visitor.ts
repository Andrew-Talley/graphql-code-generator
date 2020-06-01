import {
  transformComment,
  wrapWithSingleQuotes,
  DeclarationBlock,
  indent,
  BaseTypesVisitor,
  ParsedTypesConfig,
  getConfigValue,
  DeclarationKind,
  normalizeAvoidOptionals,
  AvoidOptionalsConfig,
  BaseVisitorConvertOptions,
  ConvertOptions,
  DEFAULT_SCALARS,
} from '@graphql-codegen/visitor-plugin-common';
import { PythonPluginConfig } from './config';
import autoBind from 'auto-bind';
import {
  FieldDefinitionNode,
  NamedTypeNode,
  ListTypeNode,
  NonNullTypeNode,
  EnumTypeDefinitionNode,
  Kind,
  InputValueDefinitionNode,
  GraphQLSchema,
  isEnumType,
  ObjectTypeDefinitionNode,
  ASTNode,
  EnumValueDefinitionNode,
  UnionTypeDefinitionNode,
  InterfaceTypeDefinitionNode,
  InputObjectTypeDefinitionNode,
} from 'graphql';
import { TypeScriptOperationVariablesToObject } from './typescript-variables-to-object';
import { PythonDeclarationBlock } from './declaration-block';

export interface PythonPluginParsedConfig extends ParsedTypesConfig {}

export class TsVisitor<
  PyRawConfig extends PythonPluginConfig = PythonPluginConfig,
  PyParsedConfig extends PythonPluginParsedConfig = PythonPluginParsedConfig
> extends BaseTypesVisitor<PyRawConfig, PyParsedConfig> {
  constructor(schema: GraphQLSchema, pluginConfig: PyRawConfig, additionalConfig: Partial<PyParsedConfig> = {}) {
    super(schema, pluginConfig, additionalConfig as PyParsedConfig);

    autoBind(this);
    const enumNames = Object.values(schema.getTypeMap())
      .filter(isEnumType)
      .map(type => type.name);
    this.setArgumentsTransformer(
      new TypeScriptOperationVariablesToObject(
        this.scalars,
        this.convertName,
        false,
        this.config.immutableTypes,
        null,
        enumNames,
        pluginConfig.enumPrefix,
        this.config.enumValues
      )
    );
    this.setDeclarationBlockConfig({
      enumNameValueSeparator: ' =',
      ignoreExport: true,
    });
  }

  public getWrapperDefinitions(): string[] {
    return [];
  }

  protected _getScalar(name: string) {
    switch (name) {
      case 'String':
        return 'str';
      case 'Boolean':
        return 'bool';
      case 'Int':
        return 'int';
      case 'Float':
        return 'float';
      default:
        return name;
    }
  }

  public get scalarsDefinition() {
    const defaultScalars = Object.keys(DEFAULT_SCALARS);
    const allScalars = Object.keys(this.config.scalars);
    const customScalars = allScalars.filter(scalar => defaultScalars.indexOf(scalar) === -1);

    customScalars.unshift('ID');

    const scalarDefs = customScalars.map(scalarName => {
      const scalarValue = this.config.scalars[scalarName].type;
      const scalarType = this._schema.getType(scalarName);
      const comment =
        scalarType && scalarType.astNode && scalarType.description ? transformComment(scalarType.description, 1) : '';

      return comment + indent(`${scalarName} = ${scalarValue}`, 0);
    });
    return scalarDefs.join('\n');
  }

  protected clearOptional(str: string): string {
    if (str.startsWith('Optional')) {
      return str.replace(/Optional\[(.*?)\]$/, '$1');
    }

    return str;
  }

  protected getExportPrefix(): string {
    return '';
  }

  NamedType(node: NamedTypeNode, key, parent, path, ancestors): string {
    return `Optional[${super.NamedType(node, key, parent, path, ancestors)}]`;
  }

  ListType(node: ListTypeNode): string {
    return `Optional[${super.ListType(node)}]`;
  }

  protected wrapWithListType(str: string): string {
    return `${this.config.immutableTypes ? 'List' : 'List'}[${str}]`;
  }

  NonNullType(node: NonNullTypeNode): string {
    const baseValue = super.NonNullType(node);

    return this.clearOptional(baseValue);
  }

  getObjectTypeDeclarationBlock(
    node: ObjectTypeDefinitionNode,
    originalNode: ObjectTypeDefinitionNode
  ): DeclarationBlock {
    const { type } = this._parsedConfig.declarationKind;
    const allFields = [...(this.config.addTypename ? [indent(`__typename: str`)] : []), ...node.fields] as string[];
    const interfacesNames = originalNode.interfaces ? originalNode.interfaces.map(i => this.convertName(i)) : [];

    const declarationBlock = new PythonDeclarationBlock({
      ...this._declarationBlockConfig,
    })
      .export()
      .asKind('class')
      .withName(this.convertName(node))
      .withComment((node.description as any) as string);

    if (type === 'interface' || type === 'class') {
      if (interfacesNames.length > 0) {
        declarationBlock.withContent(' extends ' + interfacesNames.join(', ') + (allFields.length > 0 ? ' ' : ' {}'));
      }

      declarationBlock.withBlock(this.mergeAllFields(allFields, false));
    } else {
      this.appendInterfacesAndFieldsToBlock(declarationBlock, interfacesNames, allFields);
    }

    return declarationBlock;
  }

  FieldDefinition(node: FieldDefinitionNode, key?: number | string, parent?: any): string {
    const typeString = (node.type as any) as string;
    const originalFieldNode = parent[key] as FieldDefinitionNode;
    const comment = this.getFieldComment(node);
    const { type } = this.config.declarationKind;

    return (
      comment +
      indent(`${this.config.immutableTypes ? 'readonly ' : ''}${node.name}: ${typeString}${this.getPunctuation(type)}`)
    );
  }

  getInputObjectDeclarationBlock(node: InputObjectTypeDefinitionNode): DeclarationBlock {
    return new PythonDeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind(this._parsedConfig.declarationKind.input)
      .withName(this.convertName(node))
      .withComment((node.description as any) as string)
      .withBlock(node.fields.join('\n'));
  }

  protected buildEnumValuesBlock(typeName: string, values: ReadonlyArray<EnumValueDefinitionNode>) {
    return values
      .map(enumOption => {
        const optionName = this.convertName(enumOption, {
          useTypesPrefix: false,
          transformUnderscore: true,
        });
        const comment = transformComment((enumOption.description as any) as string, 1);
        let enumValue: string | number = enumOption.name as any;

        if (
          this.config.enumValues[typeName] &&
          this.config.enumValues[typeName].mappedValues &&
          typeof this.config.enumValues[typeName].mappedValues[enumValue] !== 'undefined'
        ) {
          enumValue = this.config.enumValues[typeName].mappedValues[enumValue];
        }

        return (
          comment +
          indent(
            `${optionName}${this._declarationBlockConfig.enumNameValueSeparator} ${wrapWithSingleQuotes(enumValue)}`
          )
        );
      })
      .join('\n');
  }

  getInterfaceTypeDeclarationBlock(
    node: InterfaceTypeDefinitionNode,
    originalNode: InterfaceTypeDefinitionNode
  ): DeclarationBlock {
    const declarationBlock = new PythonDeclarationBlock({})
      .export()
      .asKind(this._parsedConfig.declarationKind.interface)
      .withName(this.convertName(node))
      .withComment((node.description as any) as string);

    return declarationBlock.withBlock(node.fields.join('\n'));
  }

  protected mergeInterfaces(interfaces: string[]): string {
    if (interfaces.length === 0) return '';

    return `(${interfaces.join(', ')})`;
  }

  EnumTypeDefinition(node: EnumTypeDefinitionNode): string {
    const enumName = (node.name as any) as string;

    // In case of mapped external enum string
    // if (this.config.enumValues[enumName] && this.config.enumValues[enumName].sourceFile) {
    //   return `export { ${this.config.enumValues[enumName].typeIdentifier} };\n`;
    // }

    const enumTypeName = this.convertName(node, { useTypesPrefix: this.config.enumPrefix });

    return new PythonDeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind('enum')
      .withName(enumTypeName)
      .withComment((node.description as any) as string)
      .withBlock(this.buildEnumValuesBlock(enumName, node.values)).string;
  }

  UnionTypeDefinition(node: UnionTypeDefinitionNode, key: string | number | undefined, parent: any): string {
    const originalNode = parent[key] as UnionTypeDefinitionNode;
    const possibleTypes = originalNode.types
      .map(t => (this.scalars[t.name.value] ? this._getScalar(t.name.value) : this.convertName(t)))
      .join(', ');

    return new PythonDeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind('union')
      .withName(this.convertName(node))
      .withComment((node.description as any) as string)
      .withContent(possibleTypes).string;
  }

  protected _buildTypeImport;

  protected getPunctuation(declarationKind: DeclarationKind): string {
    return '';
  }
}
