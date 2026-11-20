Pod::Spec.new do |s|
  s.name = 'ShutKeychain'
  s.version = '1.0.0'
  s.summary = 'SHUT: vault key in the iOS Keychain behind Face ID / Touch ID'
  s.license = 'MIT'
  s.homepage = 'https://github.com/noname15092025-ctrl/seif'
  s.author = 'SHUT'
  s.source = { :git => 'https://github.com/noname15092025-ctrl/seif.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.frameworks = 'LocalAuthentication', 'Security'
  s.swift_version = '5.1'
end
