pipeline {
    agent any

    environment {
        NODE_VERSION = '18'
        DOCKERHUB_CREDENTIALS = credentials('dockerhub-credentials')
        DOCKER_REGISTRY = 'docker.io/pyroborn'
        IMAGE_NAME = 'pyroborn/status-service'
        IMAGE_TAG = "${BUILD_NUMBER}"
        DOCKER_CONFIG = "${WORKSPACE}/.docker"
        GIT_REPO_URL = 'https://github.com/Pyroborn/k8s-argoCD.git'
        GIT_CREDENTIALS_ID = 'github-credentials'
    }

    stages {
        stage('Setup') {
            steps {
                // Clean workspace before starting
                cleanWs()
                // Checkout code
                checkout scm
                // Install dependencies using clean install
                sh 'npm ci'
            }
        }

        stage('Test') {
            environment {
                // Test environment variables
                NODE_ENV = 'test'
                PORT = '4001'
                MONGODB_URI = 'mongodb://localhost:27017/status-service-test'
                MONGODB_DATABASE = 'status-service-test'
                JWT_SECRET = 'test-jwt-secret'
                SERVICE_API_KEY = 'test-api-key'
                RABBITMQ_URL = 'amqp://guest:guest@localhost:5672'
                LOG_LEVEL = 'error'
                JEST_JUNIT_OUTPUT_DIR = 'reports'
                JEST_JUNIT_OUTPUT_NAME = 'junit.xml'
            }
            steps {
                // Create reports directory
                sh 'mkdir -p reports'
                
                // Start MongoDB for testing (using a docker container)
                //sh '''
                //    docker run -d --name mongo-test -p 27017:27017 mongo:4.4
                //    # Wait for MongoDB to start
                //     sleep 5
                //'''
                
                // Run tests with coverage
                sh 'npm run test:coverage -- --ci --reporters=default --reporters=jest-junit'

                // Publish test results and coverage
                junit(testResults: 'reports/junit.xml', allowEmptyResults: true)
                
                publishHTML(target: [
                    allowMissing: true,
                    alwaysLinkToLastBuild: true,
                    keepAll: true,
                    reportDir: 'coverage/lcov-report',
                    reportFiles: 'index.html',
                    reportName: 'Coverage Report'
                ])

                // Archive artifacts
                archiveArtifacts(
                    artifacts: 'reports/**, coverage/**',
                    allowEmptyArchive: true
                )
            }
            post {
                always {
                    // Stop and remove MongoDB container
                    sh 'docker stop mongo-test || true'
                    sh 'docker rm mongo-test || true'
                }
            }
        }
        
        stage('Build Image') {
            steps {
                script {
                    // Build the Docker image
                    sh "docker build -t ${IMAGE_NAME}:${BUILD_NUMBER} ."
                    sh "docker tag ${IMAGE_NAME}:${BUILD_NUMBER} ${IMAGE_NAME}:latest"
                }
            }
        }
        
        stage('Security Scan') {
            steps {
                script {
                    // Create directory for Trivy reports
                    sh 'mkdir -p security-reports'
                    
                    // Run Trivy scan but continue even if vulnerabilities are found
                    sh """
                        # Install Trivy if not already installed (only needed first time)
                        if ! command -v trivy &> /dev/null; then
                            echo "Trivy not found, installing..."
                            curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /tmp
                            export PATH=$PATH:/tmp
                        fi
                        
                        curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/html.tpl -o /tmp/html.tpl
                        # Run Trivy scan and output to HTML and JSON reports
                        trivy image --no-progress --exit-code 0 --scanners vuln --format template --template /tmp/html.tpl -o security-reports/trivy-report.html ${IMAGE_NAME}:${BUILD_NUMBER}
                        trivy image --no-progress --exit-code 0 --scanners vuln --format json -o security-reports/trivy-report.json ${IMAGE_NAME}:${BUILD_NUMBER}
                        echo "Security scan completed - results won't fail the build"
                    """
                    
                    // Publish HTML report
                    publishHTML(target: [
                        allowMissing: true,
                        alwaysLinkToLastBuild: true,
                        keepAll: true,
                        reportDir: 'security-reports',
                        reportFiles: 'trivy-report.html',
                        reportName: 'Trivy Security Scan'
                    ])
                    
                    // Archive security reports
                    archiveArtifacts(
                        artifacts: 'security-reports/**',
                        allowEmptyArchive: true
                    )
                }
            }
        }

        stage('Push to DockerHub') {
            steps {
                script {
                    // Create a dummy docker config (optional on newer Jenkins)
                    sh '''
                        mkdir -p ${DOCKER_CONFIG}
                        echo '{"auths": {"https://index.docker.io/v1/": {}}}' > ${DOCKER_CONFIG}/config.json
                    '''
                    withCredentials([usernamePassword(credentialsId: 'dockerhub-credentials', passwordVariable: 'DOCKERHUB_PASSWORD', usernameVariable: 'DOCKERHUB_USERNAME')]) {
                        sh '''
                            echo "${DOCKERHUB_PASSWORD}" | docker login -u "${DOCKERHUB_USERNAME}" --password-stdin
                            docker push ${IMAGE_NAME}:${BUILD_NUMBER}
                            docker push ${IMAGE_NAME}:latest
                            docker logout
                        '''
                    }
                }
            }
        }

         stage('Update GitOps Repository') {
            steps {
                script {
                    // Temporary directory for GitOps repo
                    sh 'rm -rf gitops-repo && mkdir -p gitops-repo'
                    
                    // Clone with Jenkins GitSCM
                    dir('gitops-repo') {
                        // Use the built-in Git SCM to clone
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: '*/main']],
                            extensions: [
                                [$class: 'CleanBeforeCheckout'], 
                                [$class: 'CloneOption', depth: 1, noTags: false, reference: '', shallow: true]
                            ],
                            userRemoteConfigs: [[
                                url: "${GIT_REPO_URL}",
                                credentialsId: "${GIT_CREDENTIALS_ID}"
                            ]]
                        ])
                        
                        // Set up Git with credentials for push
                        withCredentials([usernamePassword(
                            credentialsId: "${GIT_CREDENTIALS_ID}",
                            usernameVariable: 'GIT_USERNAME',
                            passwordVariable: 'GIT_PASSWORD'
                        )]) {
                            sh """
                                # Configure Git
                                git config user.email "jenkins@example.com"
                                git config user.name "Jenkins CI"
                                
                                # Verify we can access the deployment file
                                ls -la deployments/ || echo "Deployments directory not found"
                                ls -la deployments/status-service/ || echo "Status service directory not found"
                                
                                if [ -f deployments/status-service/deployment.yaml ]; then
                                    echo "Found deployment file. Current content:"
                                    cat deployments/status-service/deployment.yaml
                                    
                                    # Update image tag with proper regex - target only the line after 'name: status-service'
                                    echo "Updating image tag to ${IMAGE_NAME}:${BUILD_NUMBER}"
                                    
                                    # First check if we can find the container section
                                    if grep -A 5 "name: status-service" deployments/status-service/deployment.yaml | grep -q "image:"; then
                                        echo "Found image line near 'name: status-service', updating it..."
                                        # Use sed to maintain exact indentation (8 spaces/2 tabs)
                                        sed -i "s|^\\(        image: ${IMAGE_NAME}:\\).*|\\1${BUILD_NUMBER}|g" deployments/status-service/deployment.yaml
                                    else
                                        echo "WARNING: Could not find image line near 'name: status-service'. Please check the deployment file structure."
                                        # Insert image line with proper indentation (8 spaces) after the name line
                                        sed -i "/^        - name: status-service/ a\\        image: ${IMAGE_NAME}:${BUILD_NUMBER}" deployments/status-service/deployment.yaml
                                    fi
                                    
                                    echo "Updated content:"
                                    cat deployments/status-service/deployment.yaml
                                    
                                    # Check for changes
                                    if git diff --quiet deployments/status-service/deployment.yaml; then
                                        echo "No changes detected in deployment file"
                                    else
                                        echo "Changes detected, committing..."
                                        git add deployments/status-service/deployment.yaml
                                        git commit -m "Update status-service image to ${BUILD_NUMBER}"
                                        
                                        # Set up remote URL with credentials
                                        git remote set-url origin https://${GIT_USERNAME}:${GIT_PASSWORD}@github.com/Pyroborn/k8s-argoCD.git                                        
                                        # Push changes
                                        git push origin HEAD:main
                                        echo "Successfully pushed changes to GitOps repository"
                                    fi
                                else
                                    echo "ERROR: Deployment file not found at deployments/status-service/deployment.yaml"
                                    # List directory structure to help diagnose
                                    find . -type f -name "*.yaml" | sort
                                    exit 1
                                fi
                            """
                        }
                    }
                }
            }
        }
    }
    post {
        always {
            cleanWs()
        }
        success {
            echo 'Pipeline completed successfully!'
        }
        failure {
            echo 'Pipeline failed!'
        }
    }
}
